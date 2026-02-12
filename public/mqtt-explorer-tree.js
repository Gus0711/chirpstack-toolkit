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
  var treeContainer = document.getElementById('mqtt-tree-container');

  var flatNodes = [];
  var selectedTopic = null;
  var rowPool = [];
  var visibleStart = 0;
  var visibleEnd = 0;

  // Name resolution caches (received from backend via names_update)
  var deviceNames = {};      // devEui -> { name, tags }
  var applicationNames = {}; // appId -> name

  // ── Scroll stability state ──
  // Track the topic at the top of the visible area so we can anchor to it
  var anchorTopic = null;       // fullTopic of the first visible node
  var anchorOffset = 0;         // pixel offset within that row (scrollTop % ROW_HEIGHT)
  var prevNodeCount = 0;        // previous flatNodes.length for new-topics detection
  var newTopicsBelowCount = 0;  // topics added below viewport since last user scroll

  // ── "New topics" indicator ──
  var newTopicsBadge = document.createElement('div');
  newTopicsBadge.className = 'mqtt-new-topics-badge hidden';
  newTopicsBadge.addEventListener('click', function () {
    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
    hideNewTopicsBadge();
  });
  treeContainer.style.position = 'relative';
  treeContainer.appendChild(newTopicsBadge);

  function showNewTopicsBadge(count) {
    newTopicsBadge.textContent = count + ' new topic' + (count > 1 ? 's' : '') + ' \u2193';
    newTopicsBadge.classList.remove('hidden');
  }

  function hideNewTopicsBadge() {
    newTopicsBelowCount = 0;
    newTopicsBadge.classList.add('hidden');
  }

  // ── Snapshot scroll anchor before update ──
  function snapshotAnchor() {
    var scrollTop = container.scrollTop;
    if (scrollTop <= 0 || flatNodes.length === 0) {
      anchorTopic = null;
      anchorOffset = 0;
      return;
    }
    var idx = Math.floor(scrollTop / ROW_HEIGHT);
    idx = Math.min(idx, flatNodes.length - 1);
    anchorTopic = flatNodes[idx] ? flatNodes[idx].fullTopic : null;
    anchorOffset = scrollTop - (idx * ROW_HEIGHT);
  }

  // ── Restore scroll after update using the anchor ──
  function restoreAnchor(newNodes) {
    if (!anchorTopic) return; // was at top, no restore needed

    // Find the anchor topic in the new list
    var newIdx = -1;
    for (var i = 0; i < newNodes.length; i++) {
      if (newNodes[i].fullTopic === anchorTopic) {
        newIdx = i;
        break;
      }
    }

    if (newIdx >= 0) {
      var targetScroll = newIdx * ROW_HEIGHT + anchorOffset;
      container.scrollTop = targetScroll;
    }
    // If anchor not found (topic was removed/collapsed), keep current scrollTop
  }

  // ── Detect new topics below viewport ──
  function detectNewTopicsBelow(oldNodes, newNodes) {
    // Only track if user has scrolled (not at bottom)
    var scrollTop = container.scrollTop;
    var viewHeight = container.clientHeight;
    var totalHeight = newNodes.length * ROW_HEIGHT;
    var isAtBottom = (scrollTop + viewHeight) >= (totalHeight - ROW_HEIGHT);

    if (isAtBottom || scrollTop <= 0) {
      hideNewTopicsBadge();
      return;
    }

    // Build set of old topics for fast lookup
    var oldTopics = {};
    for (var i = 0; i < oldNodes.length; i++) {
      oldTopics[oldNodes[i].fullTopic] = true;
    }

    // Count new topics that are below the visible area
    var visEnd = Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT);
    var newBelow = 0;
    for (var j = visEnd; j < newNodes.length; j++) {
      if (!oldTopics[newNodes[j].fullTopic]) {
        newBelow++;
      }
    }

    if (newBelow > 0) {
      newTopicsBelowCount += newBelow;
      showNewTopicsBadge(newTopicsBelowCount);
    }
  }

  // ── Virtual scroll rendering ──
  function render() {
    var totalHeight = flatNodes.length * ROW_HEIGHT;
    spacer.style.height = totalHeight + 'px';

    var scrollTop = container.scrollTop;
    var viewHeight = container.clientHeight;
    var firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    var start = Math.max(0, firstVisible - OVERSCAN);
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

  var MAX_SEGMENT_LEN = 20;

  function createRow() {
    var el = document.createElement('div');
    el.className = 'mqtt-tree-row';

    var indent = document.createElement('span');
    indent.className = 'tree-indent';

    var arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    arrow.textContent = '\u25B6';

    var activity = document.createElement('span');
    activity.className = 'tree-activity';

    var segment = document.createElement('span');
    segment.className = 'tree-segment';

    var resolvedName = document.createElement('span');
    resolvedName.className = 'tree-resolved-name';

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
    el.appendChild(activity);
    el.appendChild(segment);
    el.appendChild(resolvedName);
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
      activity: activity,
      segment: segment,
      resolvedName: resolvedName,
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

    // Indent with guide lines
    var indentWidth = node.depth * 16;
    r.indent.style.width = indentWidth + 'px';
    r.indent.style.flexShrink = '0';
    // Render guide lines (one per depth level)
    r.indent.innerHTML = '';
    for (var g = 0; g < node.depth; g++) {
      var guide = document.createElement('span');
      guide.className = 'tree-indent-guide';
      guide.style.left = (g * 16 + 7) + 'px';
      r.indent.appendChild(guide);
    }

    // Arrow
    if (node.hasChildren) {
      r.arrow.style.visibility = 'visible';
      r.arrow.className = 'tree-arrow' + (node.expanded ? ' expanded' : '');
    } else {
      r.arrow.style.visibility = 'hidden';
    }

    // Activity badge
    if (node.lastReceived > 0) {
      var age = (Date.now() - node.lastReceived) / 1000;
      r.activity.style.display = '';
      if (age < 10) {
        r.activity.className = 'tree-activity activity-hot';
      } else if (age < 60) {
        r.activity.className = 'tree-activity activity-warm';
      } else {
        r.activity.className = 'tree-activity activity-cold';
      }
    } else {
      r.activity.style.display = 'none';
    }

    // Segment (truncate long names, show full topic in tooltip)
    if (node.segment.length > MAX_SEGMENT_LEN) {
      r.segment.textContent = node.segment.substring(0, MAX_SEGMENT_LEN) + '\u2026';
      r.segment.title = node.fullTopic;
    } else {
      r.segment.textContent = node.segment;
      r.segment.title = '';
    }

    // Resolved name (device/application name from ChirpStack)
    if (node.resolvedName) {
      r.resolvedName.textContent = node.resolvedName;
      r.resolvedName.style.display = '';
      r.resolvedName.title = node.segment + ' \u2192 ' + node.resolvedName;
      // Dim the segment when we have a resolved name (show name as primary)
      r.segment.classList.add('has-resolved-name');
    } else {
      r.resolvedName.textContent = '';
      r.resolvedName.style.display = 'none';
      r.segment.classList.remove('has-resolved-name');
    }

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

    // If user scrolls to bottom, dismiss badge
    var scrollTop = container.scrollTop;
    var viewHeight = container.clientHeight;
    var totalHeight = flatNodes.length * ROW_HEIGHT;
    if ((scrollTop + viewHeight) >= (totalHeight - ROW_HEIGHT)) {
      hideNewTopicsBadge();
    }
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
    prevNodeCount = 0;
    hideNewTopicsBadge();
    render();
    if (window.MqttExplorerDetail) {
      window.MqttExplorerDetail.clear();
    }
  });

  // ── Tree update from WS ──
  function onTreeUpdate(nodes) {
    var oldNodes = flatNodes;

    // 1. Snapshot the current scroll anchor BEFORE changing flatNodes
    snapshotAnchor();

    // 2. Detect new topics below the viewport (for badge)
    detectNewTopicsBelow(oldNodes, nodes);

    // 3. Replace data
    flatNodes = nodes;

    // 4. Restore scroll position using anchor, then render
    restoreAnchor(nodes);
    render();

    prevNodeCount = nodes.length;
  }

  // ── Helpers ──
  function debounce(fn, ms) {
    var timer;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  // ── Names update from WS ──
  function onNamesUpdate(devices, applications) {
    deviceNames = devices || {};
    applicationNames = applications || {};
  }

  // ── Public API ──
  window.MqttExplorerTree = {
    onTreeUpdate: onTreeUpdate,
    onNamesUpdate: onNamesUpdate,
    getSelectedTopic: function () { return selectedTopic; },
    getDeviceNames: function () { return deviceNames; },
    getApplicationNames: function () { return applicationNames; },
  };
})();
