// MQTT Explorer — Detail panel (tabs, JSON renderer, diff, sparklines)
(function () {
  'use strict';

  var elEmpty = document.getElementById('mqtt-detail-empty');
  var elView = document.getElementById('mqtt-detail-view');
  var elTopic = document.getElementById('mqtt-detail-topic');
  var elMeta = document.getElementById('mqtt-detail-meta');
  var elFormat = document.getElementById('mqtt-detail-format');
  var elPayload = document.getElementById('mqtt-detail-payload');
  var elHistorySection = document.getElementById('mqtt-detail-history-section');
  var elHistoryEmpty = document.getElementById('mqtt-detail-history-empty');
  var elDiffSection = document.getElementById('mqtt-detail-diff-section');
  var elDiffEmpty = document.getElementById('mqtt-detail-diff-empty');
  var elDiff = document.getElementById('mqtt-detail-diff');
  var sparklineCanvas = document.getElementById('mqtt-detail-sparkline');
  var elCopyBtn = document.getElementById('mqtt-detail-copy-btn');

  // Tabs
  var tabs = document.querySelectorAll('.mqtt-detail-tab');
  var panels = {
    payload: document.getElementById('mqtt-panel-payload'),
    history: document.getElementById('mqtt-panel-history'),
    diff: document.getElementById('mqtt-panel-diff'),
    visualizer: document.getElementById('mqtt-panel-visualizer'),
  };
  var tabHistory = document.getElementById('mqtt-tab-history');
  var tabDiff = document.getElementById('mqtt-tab-diff');
  var tabVisualizer = document.getElementById('mqtt-tab-visualizer');
  var elVisualizer = document.getElementById('mqtt-detail-visualizer');
  var activeTab = 'payload';
  var lastPayloadFormat = null;
  var visualizerDirty = true;

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var target = tab.dataset.tab;
      if (!target || target === activeTab) return;
      switchTab(target);
    });
  });

  function switchTab(name) {
    activeTab = name;
    tabs.forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    Object.keys(panels).forEach(function (key) {
      panels[key].classList.toggle('hidden', key !== name);
    });
    // Lazy render visualizer
    if (name === 'visualizer' && visualizerDirty && lastPayloadFormat === 'json' && lastPayloadText) {
      window.MqttExplorerVisualizer.render(elVisualizer, lastPayloadText);
      visualizerDirty = false;
    }
  }

  // Copy button
  elCopyBtn.addEventListener('click', function () {
    if (!lastPayloadText) return;
    copyToClipboard(lastPayloadText);
    // Brief visual feedback
    elCopyBtn.classList.add('text-[#00d4aa]');
    setTimeout(function () { elCopyBtn.classList.remove('text-[#00d4aa]'); }, 800);
  });

  var sparklineChart = null;
  var currentTopic = null;
  var lastPayloadText = null;
  var hasDiff = false;
  var hasHistory = false;

  function onMessage(msg) {
    currentTopic = msg.topic;
    elEmpty.classList.add('hidden');
    elView.classList.remove('hidden');

    // Topic
    elTopic.textContent = msg.topic;

    // Meta
    elMeta.innerHTML = '';
    addMetaTag('QoS ' + msg.qos);
    addMetaTag(formatBytes(msg.size));
    if (msg.retain) {
      addMetaTag(t('mqtt.retained'), 'text-yellow-400');
    }
    if (msg.messageCount) {
      addMetaTag('#' + msg.messageCount);
    }

    // Copy topic button in meta
    var copyTopicBtn = document.createElement('button');
    copyTopicBtn.className = 'text-white/30 hover:text-white/60 transition-colors';
    copyTopicBtn.title = t('mqtt.copy_topic');
    copyTopicBtn.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
    copyTopicBtn.addEventListener('click', function () { copyToClipboard(msg.topic); });
    elMeta.appendChild(copyTopicBtn);

    // Format badge
    elFormat.textContent = msg.format.toUpperCase();
    lastPayloadFormat = msg.format;

    // Payload rendering
    var previousText = lastPayloadText;
    lastPayloadText = msg.payloadText;

    // Visualizer dirty flag + tab indicator
    visualizerDirty = true;
    if (msg.format === 'json') {
      tabVisualizer.classList.add('has-content');
      if (activeTab === 'visualizer') {
        window.MqttExplorerVisualizer.render(elVisualizer, msg.payloadText);
        visualizerDirty = false;
      }
    } else {
      tabVisualizer.classList.remove('has-content');
    }

    if (msg.format === 'json') {
      renderJson(elPayload, msg.payloadText);
    } else {
      elPayload.textContent = msg.payloadText;
    }

    // Diff
    var prevText = msg.previousPayloadText || previousText;
    if (prevText && prevText !== msg.payloadText) {
      hasDiff = true;
      elDiffSection.classList.remove('hidden');
      elDiffEmpty.classList.add('hidden');
      renderDiff(elDiff, prevText, msg.payloadText, msg.format);
      tabDiff.classList.add('has-content');
    } else {
      hasDiff = false;
      elDiffSection.classList.add('hidden');
      elDiffEmpty.classList.remove('hidden');
      tabDiff.classList.remove('has-content');
    }

    // Value history sparkline
    if (msg.valueHistory && msg.valueHistory.length > 1) {
      var hasValues = msg.valueHistory.some(function (v) { return v.value !== null; });
      if (hasValues) {
        hasHistory = true;
        elHistorySection.classList.remove('hidden');
        elHistoryEmpty.classList.add('hidden');
        renderSparkline(msg.valueHistory);
        tabHistory.classList.add('has-content');
      } else {
        hasHistory = false;
        elHistorySection.classList.add('hidden');
        elHistoryEmpty.classList.remove('hidden');
        tabHistory.classList.remove('has-content');
      }
    } else {
      hasHistory = false;
      elHistorySection.classList.add('hidden');
      elHistoryEmpty.classList.remove('hidden');
      tabHistory.classList.remove('has-content');
    }
  }

  function addMetaTag(text, extraClass) {
    var span = document.createElement('span');
    span.className = 'text-xs px-1.5 py-0.5 rounded bg-white/5 ' + (extraClass || 'text-white/40');
    span.textContent = text;
    elMeta.appendChild(span);
  }

  // ── JSON renderer ──
  function renderJson(container, text) {
    try {
      var obj = JSON.parse(text);
      container.innerHTML = '';
      container.appendChild(buildJsonNode(obj, 0));
    } catch (e) {
      container.textContent = text;
    }
  }

  function buildJsonNode(value, depth) {
    if (value === null) {
      return createSpan('null', 'mqtt-json-null');
    }
    if (typeof value === 'boolean') {
      return createSpan(String(value), 'mqtt-json-bool');
    }
    if (typeof value === 'number') {
      return createSpan(String(value), 'mqtt-json-number');
    }
    if (typeof value === 'string') {
      return createSpan('"' + escapeHtml(value) + '"', 'mqtt-json-string');
    }

    var isArray = Array.isArray(value);
    var keys = isArray ? null : Object.keys(value);
    var length = isArray ? value.length : keys.length;
    var openBracket = isArray ? '[' : '{';
    var closeBracket = isArray ? ']' : '}';

    if (length === 0) {
      return createSpan(openBracket + closeBracket, 'mqtt-json-bracket');
    }

    var frag = document.createDocumentFragment();
    var toggle = createSpan(openBracket, 'mqtt-json-bracket mqtt-json-toggle');
    var content = document.createElement('div');
    content.style.marginLeft = '16px';

    var collapsed = false;
    toggle.addEventListener('click', function () {
      collapsed = !collapsed;
      content.style.display = collapsed ? 'none' : '';
      closeEl.style.display = collapsed ? 'none' : '';
      inlinePreview.style.display = collapsed ? 'inline' : 'none';
    });

    // Inline preview for collapsed state
    var inlinePreview = createSpan(' ... ' + closeBracket, 'mqtt-json-bracket');
    inlinePreview.style.display = 'none';

    var entries = isArray ? value : keys;
    for (var i = 0; i < entries.length; i++) {
      var line = document.createElement('div');
      if (!isArray) {
        line.appendChild(createSpan('"' + escapeHtml(entries[i]) + '"', 'mqtt-json-key'));
        line.appendChild(createSpan(': ', 'mqtt-json-bracket'));
        line.appendChild(buildJsonNode(value[entries[i]], depth + 1));
      } else {
        line.appendChild(buildJsonNode(entries[i], depth + 1));
      }
      if (i < entries.length - 1) {
        line.appendChild(createSpan(',', 'mqtt-json-bracket'));
      }
      content.appendChild(line);
    }

    var closeEl = createSpan(closeBracket, 'mqtt-json-bracket');

    frag.appendChild(toggle);
    frag.appendChild(inlinePreview);
    frag.appendChild(content);
    frag.appendChild(closeEl);

    var wrapper = document.createElement('span');
    wrapper.appendChild(frag);
    return wrapper;
  }

  function createSpan(text, className) {
    var span = document.createElement('span');
    span.className = className || '';
    span.textContent = text;
    return span;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Diff renderer — GitHub style ──
  function renderDiff(container, oldText, newText, format) {
    container.innerHTML = '';
    var oldLines, newLines;

    if (format === 'json') {
      try { oldLines = JSON.stringify(JSON.parse(oldText), null, 2).split('\n'); } catch (e) { oldLines = oldText.split('\n'); }
      try { newLines = JSON.stringify(JSON.parse(newText), null, 2).split('\n'); } catch (e) { newLines = newText.split('\n'); }
    } else {
      oldLines = oldText.split('\n');
      newLines = newText.split('\n');
    }

    var oldIdx = 1;
    var newIdx = 1;
    var maxLen = Math.max(oldLines.length, newLines.length);

    for (var i = 0; i < maxLen; i++) {
      var oldLine = i < oldLines.length ? oldLines[i] : undefined;
      var newLine = i < newLines.length ? newLines[i] : undefined;

      if (oldLine === newLine) {
        addDiffLine(container, oldIdx, newIdx, ' ', oldLine || '', 'mqtt-diff-ctx');
        oldIdx++;
        newIdx++;
      } else {
        if (oldLine !== undefined) {
          addDiffLine(container, oldIdx, null, '-', oldLine, 'mqtt-diff-remove');
          oldIdx++;
        }
        if (newLine !== undefined) {
          addDiffLine(container, null, newIdx, '+', newLine, 'mqtt-diff-add');
          newIdx++;
        }
      }
    }
  }

  function addDiffLine(container, oldLn, newLn, marker, text, className) {
    var line = document.createElement('div');
    line.className = 'mqtt-diff-line ' + className;

    var lnOld = document.createElement('span');
    lnOld.className = 'mqtt-diff-ln';
    lnOld.textContent = oldLn != null ? String(oldLn) : '';

    var lnNew = document.createElement('span');
    lnNew.className = 'mqtt-diff-ln';
    lnNew.textContent = newLn != null ? String(newLn) : '';

    var markerEl = document.createElement('span');
    markerEl.className = 'mqtt-diff-marker';
    markerEl.textContent = marker;

    var textEl = document.createElement('span');
    textEl.className = 'mqtt-diff-text';
    textEl.textContent = text;

    line.appendChild(lnOld);
    line.appendChild(lnNew);
    line.appendChild(markerEl);
    line.appendChild(textEl);
    container.appendChild(line);
  }

  // ── Sparkline ──
  function renderSparkline(history) {
    var labels = [];
    var data = [];
    for (var i = 0; i < history.length; i++) {
      if (history[i].value !== null) {
        labels.push(new Date(history[i].ts));
        data.push(history[i].value);
      }
    }

    if (data.length < 2) {
      elHistorySection.classList.add('hidden');
      elHistoryEmpty.classList.remove('hidden');
      return;
    }

    if (sparklineChart) {
      sparklineChart.data.labels = labels;
      sparklineChart.data.datasets[0].data = data;
      sparklineChart.update('none');
      return;
    }

    sparklineChart = new Chart(sparklineCanvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          borderColor: '#00d4aa',
          backgroundColor: 'rgba(0, 212, 170, 0.1)',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
          tension: 0.3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: { display: false },
        },
        animation: false,
      },
    });
  }

  // ── Clear ──
  function clear() {
    currentTopic = null;
    lastPayloadText = null;
    lastPayloadFormat = null;
    visualizerDirty = true;
    hasDiff = false;
    hasHistory = false;
    elEmpty.classList.remove('hidden');
    elView.classList.add('hidden');
    elDiffSection.classList.add('hidden');
    elHistorySection.classList.add('hidden');
    tabDiff.classList.remove('has-content');
    tabHistory.classList.remove('has-content');
    tabVisualizer.classList.remove('has-content');
    window.MqttExplorerVisualizer.clear();
    switchTab('payload');
    if (sparklineChart) {
      sparklineChart.destroy();
      sparklineChart = null;
    }
  }

  // ── Helpers ──
  function formatBytes(b) {
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
    return b + ' B';
  }

  function copyToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(function () {});
    }
  }

  // ── Public API ──
  window.MqttExplorerDetail = {
    onMessage: onMessage,
    clear: clear,
  };
})();
