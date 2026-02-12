// MQTT Explorer — Topic Tree with virtual scroll
(function () {
  'use strict';

  var ROW_HEIGHT = 28;
  var OVERSCAN = 10;

  var container = document.getElementById('mqtt-tree-viewport');
  var spacer = document.getElementById('mqtt-tree-spacer');
  var rowsEl = document.getElementById('mqtt-tree-rows');
  var searchInput = document.getElementById('mqtt-tree-search');
  var expandAllBtn = document.getElementById('mqtt-tree-expand-all');
  var collapseAllBtn = document.getElementById('mqtt-tree-collapse-all');
  var clearBtn = document.getElementById('mqtt-tree-clear');

  var flatNodes = [];
  var selectedTopic = null;
  var rowPool = [];
  var visibleStart = 0;
  var visibleEnd = 0;

  // ── Virtual scroll rendering ──
  function render() {
    var totalHeight = flatNodes.length * ROW_HEIGHT;
    spacer.style.height = totalHeight + 'px';

    var scrollTop = container.scrollTop;
    var viewHeight = container.clientHeight;
    var start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    var end = Math.min(flatNodes.length, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN);

    visibleStart = start;
    visibleEnd = end;

    var count = end - start;

    // Grow pool if needed
    while (rowPool.length < count) {
      var row = createRow();
      rowPool.push(row);
      rowsEl.appendChild(row.el);
    }

    // Hide extra rows
    for (var i = count; i < rowPool.length; i++) {
      rowPool[i].el.style.display = 'none';
    }

    // Bind visible rows
    for (var j = 0; j < count; j++) {
      var idx = start + j;
      var node = flatNodes[idx];
      var r = rowPool[j];
      bindRow(r, node, idx);
      r.el.style.display = '';
    }
  }

  function createRow() {
    var el = document.createElement('div');
    el.className = 'mqtt-tree-row';

    var indent = document.createElement('span');
    indent.className = 'tree-indent';

    var arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    arrow.textContent = '\u25B6';

    var segment = document.createElement('span');
    segment.className = 'tree-segment';

    var countEl = document.createElement('span');
    countEl.className = 'tree-count';

    var rateEl = document.createElement('span');
    rateEl.className = 'tree-rate';

    var retainEl = document.createElement('span');
    retainEl.className = 'tree-retain';
    retainEl.textContent = 'R';

    var preview = document.createElement('span');
    preview.className = 'tree-preview';

    el.appendChild(indent);
    el.appendChild(arrow);
    el.appendChild(segment);
    el.appendChild(countEl);
    el.appendChild(rateEl);
    el.appendChild(retainEl);
    el.appendChild(preview);

    el.addEventListener('click', function (e) {
      var topic = el.dataset.topic;
      if (!topic) return;

      // Arrow click = toggle expand
      if (e.target === arrow || e.target.closest('.tree-arrow')) {
        var isExpanded = el.dataset.expanded === 'true';
        if (isExpanded) {
          window.MqttExplorer.wsSend({ type: 'collapse', topic: topic });
        } else {
          window.MqttExplorer.wsSend({ type: 'expand', topic: topic });
        }
        return;
      }

      // Row click = select + toggle expand
      selectTopic(topic);
      var expanded = el.dataset.expanded === 'true';
      if (el.dataset.hasChildren === 'true') {
        if (expanded) {
          window.MqttExplorer.wsSend({ type: 'collapse', topic: topic });
        } else {
          window.MqttExplorer.wsSend({ type: 'expand', topic: topic });
        }
      }
    });

    return {
      el: el,
      indent: indent,
      arrow: arrow,
      segment: segment,
      countEl: countEl,
      rateEl: rateEl,
      retainEl: retainEl,
      preview: preview,
    };
  }

  function bindRow(r, node, index) {
    var yOffset = index * ROW_HEIGHT;
    r.el.style.transform = 'translateY(' + yOffset + 'px)';
    r.el.style.position = 'absolute';
    r.el.style.left = '0';
    r.el.style.right = '0';
    r.el.dataset.topic = node.fullTopic;
    r.el.dataset.expanded = String(node.expanded);
    r.el.dataset.hasChildren = String(node.hasChildren);

    // Indent
    r.indent.style.width = (node.depth * 16) + 'px';
    r.indent.style.flexShrink = '0';

    // Arrow
    if (node.hasChildren) {
      r.arrow.style.visibility = 'visible';
      r.arrow.className = 'tree-arrow' + (node.expanded ? ' expanded' : '');
    } else {
      r.arrow.style.visibility = 'hidden';
    }

    // Segment
    r.segment.textContent = node.segment;

    // Count
    if (node.messageCount > 0) {
      r.countEl.textContent = node.messageCount;
      r.countEl.style.display = '';
    } else {
      r.countEl.style.display = 'none';
    }

    // Rate
    if (node.msgPerSec > 0) {
      r.rateEl.textContent = node.msgPerSec.toFixed(1) + '/s';
      r.rateEl.style.display = '';
    } else {
      r.rateEl.style.display = 'none';
    }

    // Retain
    r.retainEl.style.display = node.retain ? '' : 'none';

    // Preview
    r.preview.textContent = node.lastPayloadPreview || '';

    // Selected state
    if (node.fullTopic === selectedTopic) {
      r.el.classList.add('selected');
    } else {
      r.el.classList.remove('selected');
    }
  }

  function selectTopic(topic) {
    selectedTopic = topic;
    window.MqttExplorer.wsSend({ type: 'select', topic: topic });
    render();
  }

  // ── Event handlers ──
  container.addEventListener('scroll', function () {
    requestAnimationFrame(render);
  });

  searchInput.addEventListener('input', debounce(function () {
    var query = searchInput.value.trim();
    window.MqttExplorer.wsSend({ type: 'filter', query: query || null });
  }, 200));

  expandAllBtn.addEventListener('click', function () {
    window.MqttExplorer.wsSend({ type: 'expand_all' });
  });

  collapseAllBtn.addEventListener('click', function () {
    window.MqttExplorer.wsSend({ type: 'collapse_all' });
  });

  clearBtn.addEventListener('click', function () {
    window.MqttExplorer.wsSend({ type: 'clear' });
    flatNodes = [];
    selectedTopic = null;
    render();
    if (window.MqttExplorerDetail) {
      window.MqttExplorerDetail.clear();
    }
  });

  // ── Tree update from WS ──
  function onTreeUpdate(nodes) {
    flatNodes = nodes;
    render();
  }

  // ── Helpers ──
  function debounce(fn, ms) {
    var timer;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  // ── Public API ──
  window.MqttExplorerTree = {
    onTreeUpdate: onTreeUpdate,
    getSelectedTopic: function () { return selectedTopic; },
  };
})();
