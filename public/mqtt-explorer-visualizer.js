// MQTT Explorer — JSON Visualizer (graph/node view)
(function () {
  'use strict';

  // ── Constants ──
  var NODE_W = 260;
  var COL_GAP = 90;
  var ROW_GAP = 12;
  var HEADER_H = 32;
  var PROP_H = 24;
  var MAX_NODES = 200;
  var AUTO_COLLAPSE_DEPTH = 3;
  var MIN_ZOOM = 0.15;
  var MAX_ZOOM = 2.5;
  var ANIM_MS = 280;

  // Depth-based accent hues for connections & headers
  var DEPTH_COLORS = [
    'rgba(0, 212, 170, 0.5)',   // teal (root)
    'rgba(86, 156, 214, 0.45)', // blue
    'rgba(206, 145, 120, 0.4)', // orange
    'rgba(168, 85, 247, 0.4)',  // purple
    'rgba(234, 179, 8, 0.35)',  // gold
    'rgba(74, 222, 128, 0.35)', // green
  ];

  // ── State ──
  var container = null;
  var viewport = null;
  var svgLayer = null;
  var nodeLayer = null;
  var toolbar = null;
  var rootNode = null;
  var nodeCount = 0;
  var zoom = 1;
  var panX = 0;
  var panY = 0;
  var isPanning = false;
  var panStartX = 0;
  var panStartY = 0;
  var panStartPanX = 0;
  var panStartPanY = 0;
  var interactionsSetup = false;
  var boundMouseMove = null;
  var boundMouseUp = null;

  // ── GNode builder ──
  function buildGraph(key, value, depth, parentType) {
    if (nodeCount >= MAX_NODES) return null;
    nodeCount++;

    var node = {
      id: 'n' + nodeCount,
      key: key,
      type: getType(value),
      depth: depth,
      parentType: parentType || null,
      props: [],
      children: [],
      collapsed: depth >= AUTO_COLLAPSE_DEPTH,
      x: 0,
      y: 0,
      height: 0,
      subtreeH: 0,
      childCount: 0, // total direct items (props + children)
    };

    if (node.type === 'object' || node.type === 'array') {
      var isArr = node.type === 'array';
      var keys = isArr ? value : Object.keys(value);
      var length = isArr ? value.length : keys.length;
      node.childCount = length;

      for (var i = 0; i < length; i++) {
        var k = isArr ? i : keys[i];
        var v = isArr ? value[i] : value[keys[i]];
        var vType = getType(v);
        var label = isArr ? '[' + k + ']' : k;

        if (vType === 'object' || vType === 'array') {
          var child = buildGraph(label, v, depth + 1, node.type);
          if (child) node.children.push(child);
        } else {
          node.props.push({ key: label, value: formatValue(v), rawValue: v, type: vType });
        }
      }
    }

    // Height
    node.height = HEADER_H + node.props.length * PROP_H;
    if (node.collapsed && node.children.length > 0) {
      node.height += PROP_H;
    }
    // Minimum height for empty nodes
    if (node.props.length === 0 && node.children.length === 0) {
      node.height = HEADER_H + PROP_H;
    }

    return node;
  }

  function getType(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  function formatValue(v) {
    if (v === null) return 'null';
    if (typeof v === 'string') {
      if (v.length > 40) return '"' + v.substring(0, 37) + '..."';
      return '"' + v + '"';
    }
    return String(v);
  }

  // ── Layout ──
  function calcSubtreeH(node) {
    if (node.collapsed || node.children.length === 0) {
      node.subtreeH = node.height;
      return node.subtreeH;
    }
    var childrenTotalH = 0;
    for (var i = 0; i < node.children.length; i++) {
      if (i > 0) childrenTotalH += ROW_GAP;
      childrenTotalH += calcSubtreeH(node.children[i]);
    }
    node.subtreeH = Math.max(node.height, childrenTotalH);
    return node.subtreeH;
  }

  function positionNode(node, x, yCenter) {
    node.x = x;
    node.y = yCenter - node.height / 2;

    if (node.collapsed || node.children.length === 0) return;

    var childX = x + NODE_W + COL_GAP;
    var totalChildH = 0;
    for (var i = 0; i < node.children.length; i++) {
      if (i > 0) totalChildH += ROW_GAP;
      totalChildH += node.children[i].subtreeH;
    }

    var startY = yCenter - totalChildH / 2;
    var currentY = startY;
    for (var j = 0; j < node.children.length; j++) {
      var child = node.children[j];
      var childCenter = currentY + child.subtreeH / 2;
      positionNode(child, childX, childCenter);
      currentY += child.subtreeH + ROW_GAP;
    }
  }

  // ── Render ──
  function doRender() {
    if (!viewport || !rootNode) return;

    svgLayer.innerHTML = '';
    nodeLayer.innerHTML = '';

    var connections = [];
    renderNodeRecursive(rootNode, connections);

    for (var i = 0; i < connections.length; i++) {
      drawConnection(connections[i].parent, connections[i].child, connections[i].childIdx);
    }
  }

  function renderNodeRecursive(node, connections) {
    var el = document.createElement('div');
    el.className = 'mqtt-viz-node';
    if (node.depth === 0) el.classList.add('mqtt-viz-node-root');
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    el.style.width = NODE_W + 'px';

    // Header
    var header = document.createElement('div');
    header.className = 'mqtt-viz-node-header';
    // Depth color accent on left border
    var depthColor = DEPTH_COLORS[node.depth % DEPTH_COLORS.length];
    el.style.borderLeftColor = depthColor;

    var keySpan = document.createElement('span');
    keySpan.className = 'mqtt-viz-node-key';
    keySpan.textContent = node.depth === 0 ? 'root' : node.key;
    keySpan.title = node.key;
    header.appendChild(keySpan);

    if (node.type === 'object' || node.type === 'array') {
      var badge = document.createElement('span');
      badge.className = 'mqtt-viz-badge mqtt-viz-badge-' + node.type;
      badge.textContent = (node.type === 'object' ? '{ }' : '[ ]') + ' ' + node.childCount;
      header.appendChild(badge);
    }

    if (node.children.length > 0) {
      var toggleBtn = document.createElement('button');
      toggleBtn.className = 'mqtt-viz-toggle';
      toggleBtn.innerHTML = node.collapsed
        ? '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      toggleBtn.title = node.collapsed ? 'Expand' : 'Collapse';
      toggleBtn.addEventListener('click', (function (n) {
        return function (e) {
          e.stopPropagation();
          n.collapsed = !n.collapsed;
          recalcHeights(rootNode);
          relayout();
        };
      })(node));
      header.appendChild(toggleBtn);
    }

    el.appendChild(header);

    // Props
    for (var i = 0; i < node.props.length; i++) {
      var prop = node.props[i];
      var propEl = document.createElement('div');
      propEl.className = 'mqtt-viz-prop';

      var propKey = document.createElement('span');
      propKey.className = 'mqtt-viz-prop-key';
      propKey.textContent = prop.key;
      propKey.title = prop.key;
      propEl.appendChild(propKey);

      var propVal = document.createElement('span');
      propVal.className = 'mqtt-viz-prop-val mqtt-viz-val-' + prop.type;
      propVal.textContent = prop.value;
      propVal.title = typeof prop.rawValue === 'string' ? prop.rawValue : prop.value;
      propEl.appendChild(propVal);

      // Color swatch
      if (prop.type === 'string' && typeof prop.rawValue === 'string') {
        var hexMatch = prop.rawValue.match(/^#([0-9a-fA-F]{3,8})$/);
        if (hexMatch) {
          var swatch = document.createElement('span');
          swatch.className = 'mqtt-viz-color-swatch';
          swatch.style.backgroundColor = prop.rawValue;
          propEl.appendChild(swatch);
        }
      }

      // Boolean icon
      if (prop.type === 'boolean') {
        var boolIcon = document.createElement('span');
        boolIcon.className = 'mqtt-viz-bool-icon';
        boolIcon.textContent = prop.rawValue ? '\u2713' : '\u2717';
        boolIcon.style.color = prop.rawValue ? '#4ade80' : '#f87171';
        propEl.appendChild(boolIcon);
      }

      el.appendChild(propEl);
    }

    // Empty object/array
    if (node.props.length === 0 && node.children.length === 0 && (node.type === 'object' || node.type === 'array')) {
      var emptyEl = document.createElement('div');
      emptyEl.className = 'mqtt-viz-collapsed-indicator';
      emptyEl.textContent = node.type === 'object' ? 'empty object' : 'empty array';
      el.appendChild(emptyEl);
    }

    // Collapsed indicator
    if (node.collapsed && node.children.length > 0) {
      var indicator = document.createElement('div');
      indicator.className = 'mqtt-viz-collapsed-indicator mqtt-viz-collapsed-clickable';
      var nestedCount = countNestedTotal(node);
      indicator.textContent = node.children.length + ' nested' + (nestedCount > node.children.length ? ' (' + nestedCount + ' total)' : '') + '...';
      indicator.addEventListener('click', (function (n) {
        return function (e) {
          e.stopPropagation();
          n.collapsed = false;
          recalcHeights(rootNode);
          relayout();
        };
      })(node));
      el.appendChild(indicator);
    }

    // Double-click to center + zoom
    el.addEventListener('dblclick', (function (n) {
      return function (e) {
        e.stopPropagation();
        animateTo(n);
      };
    })(node));

    nodeLayer.appendChild(el);

    // Recurse children
    if (!node.collapsed) {
      for (var j = 0; j < node.children.length; j++) {
        connections.push({ parent: node, child: node.children[j], childIdx: j });
        renderNodeRecursive(node.children[j], connections);
      }
    }
  }

  function countNestedTotal(node) {
    var count = 0;
    for (var i = 0; i < node.children.length; i++) {
      count++;
      count += countNestedTotal(node.children[i]);
    }
    return count;
  }

  function drawConnection(parent, child, childIdx) {
    var x1 = parent.x + NODE_W;
    // Anchor Y: after header + props, offset per child index
    var anchorY = parent.y + HEADER_H + parent.props.length * PROP_H;
    // If we have multiple children, space the anchor points
    var y1;
    if (parent.children.length <= 1) {
      y1 = parent.y + parent.height / 2;
    } else {
      var availH = Math.max(parent.height - HEADER_H - 8, 0);
      var step = parent.children.length > 1 ? availH / (parent.children.length - 1) : 0;
      y1 = parent.y + HEADER_H + 4 + step * childIdx;
    }

    var x2 = child.x;
    var y2 = child.y + Math.min(HEADER_H, child.height) / 2;

    var cpOffset = COL_GAP * 0.55;
    var d = 'M ' + x1 + ' ' + y1 +
      ' C ' + (x1 + cpOffset) + ' ' + y1 +
      ' ' + (x2 - cpOffset) + ' ' + y2 +
      ' ' + x2 + ' ' + y2;

    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'mqtt-viz-connection');
    // Depth color
    var color = DEPTH_COLORS[parent.depth % DEPTH_COLORS.length];
    path.style.stroke = color;
    svgLayer.appendChild(path);

    // Small dot at connection start
    var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', x1);
    dot.setAttribute('cy', y1);
    dot.setAttribute('r', '2.5');
    dot.setAttribute('fill', color);
    svgLayer.appendChild(dot);
  }

  function relayout() {
    if (!rootNode) return;
    calcSubtreeH(rootNode);
    positionNode(rootNode, 60, rootNode.subtreeH / 2 + 60);
    doRender();
    updateTransform();
    updateToolbarZoom();
  }

  function recalcHeights(node) {
    node.height = HEADER_H + node.props.length * PROP_H;
    if (node.collapsed && node.children.length > 0) node.height += PROP_H;
    if (node.props.length === 0 && node.children.length === 0) node.height = HEADER_H + PROP_H;
    if (!node.collapsed) {
      for (var i = 0; i < node.children.length; i++) {
        recalcHeights(node.children[i]);
      }
    }
  }

  // ── Transform ──
  function updateTransform() {
    if (!nodeLayer || !svgLayer) return;
    var transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
    nodeLayer.style.transform = transform;
    svgLayer.style.transform = transform;
  }

  function fitToView() {
    if (!rootNode || !container) return;
    var bounds = getGraphBounds(rootNode);
    var vw = container.clientWidth;
    var vh = container.clientHeight - (toolbar ? toolbar.offsetHeight : 0);
    var pad = 60;
    var gw = bounds.maxX - bounds.minX + NODE_W + pad * 2;
    var gh = bounds.maxY - bounds.minY + pad * 2;

    zoom = Math.min(1, Math.min(vw / gw, vh / gh) * 0.92);
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

    panX = (vw - gw * zoom) / 2 - bounds.minX * zoom + pad * zoom;
    panY = (vh - gh * zoom) / 2 - bounds.minY * zoom + pad * zoom;
    if (toolbar) panY += toolbar.offsetHeight;

    updateTransform();
    updateToolbarZoom();
  }

  function animateTo(node) {
    if (!container) return;
    var vw = container.clientWidth;
    var vh = container.clientHeight - (toolbar ? toolbar.offsetHeight : 0);
    var targetZoom = Math.max(0.8, Math.min(1.2, zoom));
    var nodeCenterX = node.x + NODE_W / 2;
    var nodeCenterY = node.y + node.height / 2;
    var targetPanX = vw / 2 - nodeCenterX * targetZoom;
    var targetPanY = vh / 2 - nodeCenterY * targetZoom + (toolbar ? toolbar.offsetHeight : 0);

    var startPanX = panX, startPanY = panY, startZoom = zoom;
    var startTime = performance.now();

    function step(now) {
      var elapsed = now - startTime;
      var t = Math.min(1, elapsed / ANIM_MS);
      // ease-out cubic
      var ease = 1 - Math.pow(1 - t, 3);

      panX = startPanX + (targetPanX - startPanX) * ease;
      panY = startPanY + (targetPanY - startPanY) * ease;
      zoom = startZoom + (targetZoom - startZoom) * ease;
      updateTransform();
      updateToolbarZoom();

      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function getGraphBounds(node) {
    var minX = node.x, minY = node.y;
    var maxX = node.x + NODE_W, maxY = node.y + node.height;
    if (!node.collapsed) {
      for (var i = 0; i < node.children.length; i++) {
        var cb = getGraphBounds(node.children[i]);
        if (cb.minX < minX) minX = cb.minX;
        if (cb.minY < minY) minY = cb.minY;
        if (cb.maxX > maxX) maxX = cb.maxX;
        if (cb.maxY > maxY) maxY = cb.maxY;
      }
    }
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  // ── Collapse/Expand all ──
  function setCollapseAll(node, collapsed, skipRoot) {
    if (!skipRoot) node.collapsed = collapsed;
    for (var i = 0; i < node.children.length; i++) {
      setCollapseAll(node.children[i], collapsed, false);
    }
  }

  // ── Toolbar ──
  function createToolbar() {
    toolbar = document.createElement('div');
    toolbar.className = 'mqtt-viz-toolbar';

    // Fit to view
    var fitBtn = makeToolbarBtn(
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
      'Fit to view'
    );
    fitBtn.addEventListener('click', function () { fitToView(); });
    toolbar.appendChild(fitBtn);

    // Zoom out
    var zoomOutBtn = makeToolbarBtn(
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35M8 11h6"/></svg>',
      'Zoom out'
    );
    zoomOutBtn.addEventListener('click', function () {
      zoomBy(0.8);
    });
    toolbar.appendChild(zoomOutBtn);

    // Zoom label
    var zoomLabel = document.createElement('span');
    zoomLabel.className = 'mqtt-viz-zoom-label';
    zoomLabel.id = 'mqtt-viz-zoom-label';
    zoomLabel.textContent = '100%';
    toolbar.appendChild(zoomLabel);

    // Zoom in
    var zoomInBtn = makeToolbarBtn(
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35M11 8v6M8 11h6"/></svg>',
      'Zoom in'
    );
    zoomInBtn.addEventListener('click', function () {
      zoomBy(1.25);
    });
    toolbar.appendChild(zoomInBtn);

    // Separator
    var sep = document.createElement('span');
    sep.className = 'mqtt-viz-toolbar-sep';
    toolbar.appendChild(sep);

    // Expand all
    var expandBtn = makeToolbarBtn(
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>',
      'Expand all'
    );
    expandBtn.addEventListener('click', function () {
      if (!rootNode) return;
      setCollapseAll(rootNode, false, false);
      recalcHeights(rootNode);
      relayout();
      requestAnimationFrame(function () { fitToView(); });
    });
    toolbar.appendChild(expandBtn);

    // Collapse all
    var collapseBtn = makeToolbarBtn(
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 15l-6-6-6 6"/></svg>',
      'Collapse all'
    );
    collapseBtn.addEventListener('click', function () {
      if (!rootNode) return;
      setCollapseAll(rootNode, true, true); // skip root
      recalcHeights(rootNode);
      relayout();
      requestAnimationFrame(function () { fitToView(); });
    });
    toolbar.appendChild(collapseBtn);

    return toolbar;
  }

  function makeToolbarBtn(svgHtml, title) {
    var btn = document.createElement('button');
    btn.className = 'mqtt-viz-toolbar-btn';
    btn.innerHTML = svgHtml;
    btn.title = title;
    return btn;
  }

  function updateToolbarZoom() {
    var label = document.getElementById('mqtt-viz-zoom-label');
    if (label) label.textContent = Math.round(zoom * 100) + '%';
  }

  function zoomBy(factor) {
    if (!container) return;
    var vw = container.clientWidth;
    var vh = container.clientHeight;
    var centerX = vw / 2;
    var centerY = vh / 2;

    var prevZoom = zoom;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
    panX = centerX - (centerX - panX) * (zoom / prevZoom);
    panY = centerY - (centerY - panY) * (zoom / prevZoom);
    updateTransform();
    updateToolbarZoom();
  }

  // ── Interactions ──
  function setupInteractions(el) {
    if (interactionsSetup) return;
    interactionsSetup = true;

    el.addEventListener('mousedown', function (e) {
      if (e.target.closest('.mqtt-viz-node') || e.target.closest('.mqtt-viz-toolbar')) return;
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panStartPanX = panX;
      panStartPanY = panY;
      el.style.cursor = 'grabbing';
      e.preventDefault();
    });

    boundMouseMove = function (e) {
      if (!isPanning) return;
      panX = panStartPanX + (e.clientX - panStartX);
      panY = panStartPanY + (e.clientY - panStartY);
      updateTransform();
    };
    window.addEventListener('mousemove', boundMouseMove);

    boundMouseUp = function () {
      if (isPanning) {
        isPanning = false;
        if (el) el.style.cursor = 'grab';
      }
    };
    window.addEventListener('mouseup', boundMouseUp);

    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      var rect = el.getBoundingClientRect();
      var mouseX = e.clientX - rect.left;
      var mouseY = e.clientY - rect.top;

      var prevZoom = zoom;
      var delta = e.deltaY > 0 ? 0.92 : 1.08;
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * delta));

      panX = mouseX - (mouseX - panX) * (zoom / prevZoom);
      panY = mouseY - (mouseY - panY) * (zoom / prevZoom);

      updateTransform();
      updateToolbarZoom();
    }, { passive: false });
  }

  // ── Public API ──
  function render(cont, jsonText) {
    container = cont;

    var data;
    try {
      data = JSON.parse(jsonText);
    } catch (e) {
      container.innerHTML = '';
      container.classList.remove('mqtt-viz-viewport');
      var msg = document.createElement('div');
      msg.className = 'mqtt-viz-message';
      msg.textContent = typeof t === 'function' ? t('mqtt.visualizer_not_json') : 'Only JSON payloads can be visualized';
      container.appendChild(msg);
      return;
    }

    // Handle primitive root values
    if (data === null || typeof data !== 'object') {
      container.innerHTML = '';
      container.classList.remove('mqtt-viz-viewport');
      var msg2 = document.createElement('div');
      msg2.className = 'mqtt-viz-message';
      msg2.textContent = typeof t === 'function' ? t('mqtt.visualizer_not_json') : 'Only JSON payloads can be visualized';
      container.appendChild(msg2);
      return;
    }

    // Build graph
    nodeCount = 0;
    rootNode = buildGraph('root', data, 0, null);
    if (!rootNode) {
      container.innerHTML = '';
      return;
    }

    // Setup DOM
    container.innerHTML = '';
    container.classList.add('mqtt-viz-viewport');
    interactionsSetup = false;

    // Cleanup old listeners
    if (boundMouseMove) window.removeEventListener('mousemove', boundMouseMove);
    if (boundMouseUp) window.removeEventListener('mouseup', boundMouseUp);

    // Toolbar
    container.appendChild(createToolbar());

    viewport = document.createElement('div');
    viewport.className = 'mqtt-viz-viewport-inner';

    svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgLayer.setAttribute('class', 'mqtt-viz-svg');

    nodeLayer = document.createElement('div');
    nodeLayer.className = 'mqtt-viz-node-layer';

    viewport.appendChild(svgLayer);
    viewport.appendChild(nodeLayer);
    container.appendChild(viewport);

    // Warning if truncated
    if (nodeCount >= MAX_NODES) {
      var warn = document.createElement('div');
      warn.className = 'mqtt-viz-warning';
      warn.textContent = 'Graph truncated at ' + MAX_NODES + ' nodes';
      container.appendChild(warn);
    }

    // Layout & render
    calcSubtreeH(rootNode);
    positionNode(rootNode, 60, rootNode.subtreeH / 2 + 60);
    doRender();

    // Interactions
    setupInteractions(container);
    container.style.cursor = 'grab';

    requestAnimationFrame(function () {
      fitToView();
    });
  }

  function clear() {
    if (boundMouseMove) { window.removeEventListener('mousemove', boundMouseMove); boundMouseMove = null; }
    if (boundMouseUp) { window.removeEventListener('mouseup', boundMouseUp); boundMouseUp = null; }
    rootNode = null;
    nodeCount = 0;
    zoom = 1;
    panX = 0;
    panY = 0;
    interactionsSetup = false;
    if (container) {
      container.innerHTML = '';
      container.classList.remove('mqtt-viz-viewport');
    }
    container = null;
    viewport = null;
    svgLayer = null;
    nodeLayer = null;
    toolbar = null;
  }

  window.MqttExplorerVisualizer = {
    render: render,
    clear: clear,
  };
})();
