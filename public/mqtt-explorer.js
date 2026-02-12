// MQTT Explorer — main controller (connection, WS lifecycle, profiles)
(function () {
  'use strict';

  // ── State ──
  var connectionId = null;
  var ws = null;
  var status = 'disconnected';
  var profiles = [];
  var PROFILES_KEY = 'mqttExplorerProfiles';
  var UI_STATE_KEY = 'mqttExplorerUiState';

  // ── DOM refs ──
  var elHost = document.getElementById('mqtt-host');
  var elPort = document.getElementById('mqtt-port');
  var elProtocol = document.getElementById('mqtt-protocol');
  var elUser = document.getElementById('mqtt-user');
  var elPass = document.getElementById('mqtt-pass');
  var elConnectBtn = document.getElementById('mqtt-connect-btn');
  var elDisconnectBtn = document.getElementById('mqtt-disconnect-btn');
  var elStatusDot = document.getElementById('mqtt-status-dot');
  var elStatusText = document.getElementById('mqtt-status-text');
  var elProfileSelect = document.getElementById('mqtt-profile-select');
  var elSaveProfileBtn = document.getElementById('mqtt-save-profile-btn');
  var elDeleteProfileBtn = document.getElementById('mqtt-delete-profile-btn');
  var elSubBar = document.getElementById('mqtt-sub-bar');
  var elSubTopic = document.getElementById('mqtt-sub-topic');
  var elSubQos = document.getElementById('mqtt-sub-qos');
  var elSubAddBtn = document.getElementById('mqtt-sub-add-btn');
  var elSubList = document.getElementById('mqtt-sub-list');
  var elPublishPanel = document.getElementById('mqtt-publish-panel');
  var elStatMsgTotal = document.getElementById('mqtt-stat-msg-total');
  var elStatMsgSec = document.getElementById('mqtt-stat-msg-sec');
  var elStatTopics = document.getElementById('mqtt-stat-topics');
  var elStatBytes = document.getElementById('mqtt-stat-bytes');

  // Broker display in toolbar
  var elBrokerDisplay = document.getElementById('mqtt-broker-display');
  var elBrokerDot = document.getElementById('mqtt-broker-dot');
  var elBrokerLabel = document.getElementById('mqtt-broker-label');

  // Status bar
  var elStatusBar = document.getElementById('mqtt-status-bar');
  var elStatusBarHost = document.getElementById('mqtt-statusbar-host');
  var elStatusBarDot = document.getElementById('mqtt-statusbar-dot');
  var elStatusBarUptime = document.getElementById('mqtt-statusbar-uptime');
  var elStatusBarLastMsg = document.getElementById('mqtt-statusbar-lastmsg');

  var connectedAt = null;
  var lastMessageTime = null;
  var uptimeInterval = null;

  // ── Profile management ──
  function loadProfiles() {
    try {
      profiles = JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]');
    } catch (e) { profiles = []; }
    renderProfileSelect();
  }

  function saveProfiles() {
    try { localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles)); } catch (e) { /* ignore */ }
  }

  function renderProfileSelect() {
    var val = elProfileSelect.value;
    elProfileSelect.innerHTML = '<option value="">' + t('mqtt.new_connection') + '</option>';
    profiles.forEach(function (p, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = p.name || (p.host + ':' + p.port);
      elProfileSelect.appendChild(opt);
    });
    elProfileSelect.value = val;
  }

  elProfileSelect.addEventListener('change', function () {
    var idx = parseInt(elProfileSelect.value, 10);
    if (isNaN(idx) || !profiles[idx]) return;
    var p = profiles[idx];
    elHost.value = p.host || 'localhost';
    elPort.value = p.port || 1883;
    elProtocol.value = p.protocol || 'mqtt';
    elUser.value = p.username || '';
    elPass.value = p.password || '';
  });

  elSaveProfileBtn.addEventListener('click', function () {
    var name = prompt(t('mqtt.profile_name'), elHost.value + ':' + elPort.value);
    if (!name) return;
    profiles.push({
      name: name,
      host: elHost.value,
      port: parseInt(elPort.value, 10),
      protocol: elProtocol.value,
      username: elUser.value,
      password: elPass.value,
    });
    saveProfiles();
    renderProfileSelect();
    elProfileSelect.value = String(profiles.length - 1);
  });

  elDeleteProfileBtn.addEventListener('click', function () {
    var idx = parseInt(elProfileSelect.value, 10);
    if (isNaN(idx) || !profiles[idx]) return;
    if (!confirm(t('mqtt.delete_profile_confirm'))) return;
    profiles.splice(idx, 1);
    saveProfiles();
    renderProfileSelect();
    elProfileSelect.value = '';
  });

  // ── Connection ──
  elConnectBtn.addEventListener('click', doConnect);
  elDisconnectBtn.addEventListener('click', doDisconnect);

  function doConnect() {
    var host = elHost.value.trim();
    var port = parseInt(elPort.value, 10);
    if (!host) { elHost.focus(); return; }
    if (!port || port < 1) { elPort.focus(); return; }

    setStatus('connecting');

    fetch('/api/mqtt-explorer/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: host,
        port: port,
        protocol: elProtocol.value,
        username: elUser.value || undefined,
        password: elPass.value || undefined,
        subscriptions: ['#'],
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          setStatus('error', data.error);
          return;
        }
        connectionId = data.connectionId;
        connectWebSocket();
      })
      .catch(function (err) {
        setStatus('error', err.message);
      });
  }

  function doDisconnect() {
    if (ws) { ws.close(); ws = null; }
    if (connectionId) {
      fetch('/api/mqtt-explorer/connect/' + connectionId, { method: 'DELETE' }).catch(function () {});
      connectionId = null;
    }
    setStatus('disconnected');
  }

  function connectWebSocket() {
    if (!connectionId) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/api/mqtt-explorer/ws/' + connectionId);

    ws.onopen = function () {
      // WS connected, waiting for MQTT status
    };

    ws.onmessage = function (evt) {
      try {
        var msg = JSON.parse(evt.data);
        switch (msg.type) {
          case 'status':
            setStatus(msg.status, msg.error);
            break;
          case 'tree_update':
            if (window.MqttExplorerTree) {
              window.MqttExplorerTree.onTreeUpdate(msg.nodes);
            }
            break;
          case 'stats':
            updateStats(msg);
            break;
          case 'message':
            if (window.MqttExplorerDetail) {
              window.MqttExplorerDetail.onMessage(msg);
            }
            break;
        }
      } catch (e) { /* ignore */ }
    };

    ws.onclose = function () {
      if (status !== 'disconnected') {
        setStatus('disconnected');
      }
    };

    ws.onerror = function () {
      setStatus('error', 'WebSocket error');
    };
  }

  // ── Status display ──
  function setStatus(newStatus, error) {
    status = newStatus;
    var dotColors = {
      connected: 'bg-green-500',
      connecting: 'bg-yellow-500 animate-pulse',
      disconnected: 'bg-gray-500',
      error: 'bg-red-500',
    };
    elStatusDot.className = 'w-2.5 h-2.5 rounded-full ' + (dotColors[newStatus] || 'bg-gray-500');

    if (newStatus === 'error' && error) {
      elStatusText.textContent = t('mqtt.status_error') + ': ' + error;
    } else {
      elStatusText.textContent = t('mqtt.status_' + newStatus);
    }

    var connected = newStatus === 'connected';
    elConnectBtn.classList.toggle('hidden', connected || newStatus === 'connecting');
    elDisconnectBtn.classList.toggle('hidden', !connected && newStatus !== 'connecting');
    elSubBar.classList.toggle('hidden', !connected);
    elPublishPanel.classList.toggle('hidden', !connected);

    // Broker display in toolbar
    if (connected) {
      var brokerStr = elHost.value + ':' + elPort.value;
      elBrokerLabel.textContent = brokerStr;
      elBrokerDot.className = 'w-2 h-2 rounded-full bg-green-500';
      elBrokerDisplay.classList.remove('hidden');
      elBrokerDisplay.classList.add('flex');
    } else if (newStatus === 'connecting') {
      elBrokerLabel.textContent = elHost.value + ':' + elPort.value;
      elBrokerDot.className = 'w-2 h-2 rounded-full bg-yellow-500 animate-pulse';
      elBrokerDisplay.classList.remove('hidden');
      elBrokerDisplay.classList.add('flex');
    } else {
      elBrokerDisplay.classList.add('hidden');
      elBrokerDisplay.classList.remove('flex');
    }

    // Status bar
    if (connected) {
      elStatusBar.classList.remove('hidden');
      elStatusBarHost.textContent = elHost.value + ':' + elPort.value;
      elStatusBarDot.className = 'w-2 h-2 rounded-full bg-green-500';
      if (!connectedAt) connectedAt = Date.now();
      startUptimeTimer();
    } else {
      elStatusBar.classList.add('hidden');
      connectedAt = null;
      lastMessageTime = null;
      stopUptimeTimer();
    }

    // Disable inputs while connected
    [elHost, elPort, elProtocol, elUser, elPass].forEach(function (el) {
      el.disabled = connected || newStatus === 'connecting';
      el.classList.toggle('opacity-50', el.disabled);
    });
  }

  // ── Uptime timer ──
  function startUptimeTimer() {
    if (uptimeInterval) return;
    uptimeInterval = setInterval(updateUptime, 1000);
    updateUptime();
  }

  function stopUptimeTimer() {
    if (uptimeInterval) { clearInterval(uptimeInterval); uptimeInterval = null; }
  }

  function updateUptime() {
    if (!connectedAt) return;
    var elapsed = Math.floor((Date.now() - connectedAt) / 1000);
    var h = Math.floor(elapsed / 3600);
    var m = Math.floor((elapsed % 3600) / 60);
    var s = elapsed % 60;
    elStatusBarUptime.textContent = h + ':' + pad2(m) + ':' + pad2(s);
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  // ── Stats ──
  function updateStats(msg) {
    elStatMsgTotal.textContent = formatNumber(msg.messagesTotal);
    elStatMsgSec.textContent = msg.messagesPerSec;
    elStatTopics.textContent = formatNumber(msg.topicCount);
    elStatBytes.textContent = formatBytes(msg.bytesTotal);

    // Update last message time in status bar
    if (msg.messagesTotal > 0) {
      lastMessageTime = Date.now();
      elStatusBarLastMsg.textContent = new Date(lastMessageTime).toLocaleTimeString();
    }
  }

  function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function formatBytes(b) {
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
    return b + ' B';
  }

  // ── Subscriptions ──
  var activeSubs = [];

  elSubAddBtn.addEventListener('click', addSubscription);
  elSubTopic.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') addSubscription();
  });

  function addSubscription() {
    var topic = elSubTopic.value.trim() || '#';
    var qos = parseInt(elSubQos.value, 10);
    if (!connectionId) return;

    fetch('/api/mqtt-explorer/' + connectionId + '/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: topic, qos: qos }),
    })
      .then(function (r) { return r.json(); })
      .then(function () {
        activeSubs.push({ topic: topic, qos: qos });
        renderSubList();
        elSubTopic.value = '';
      })
      .catch(function () {});
  }

  function removeSubscription(topic) {
    if (!connectionId) return;
    fetch('/api/mqtt-explorer/' + connectionId + '/subscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: topic }),
    })
      .then(function () {
        activeSubs = activeSubs.filter(function (s) { return s.topic !== topic; });
        renderSubList();
      })
      .catch(function () {});
  }

  function renderSubList() {
    elSubList.innerHTML = '';
    activeSubs.forEach(function (s) {
      var chip = document.createElement('span');
      chip.className = 'inline-flex items-center gap-1 px-2 py-0.5 bg-white/10 rounded text-xs text-white/70 font-mono';
      chip.innerHTML = s.topic + ' <button class="text-white/30 hover:text-red-400 ml-1">&times;</button>';
      chip.querySelector('button').addEventListener('click', function () { removeSubscription(s.topic); });
      elSubList.appendChild(chip);
    });
  }

  // ── Split pane resize ──
  var splitHandle = document.getElementById('mqtt-split-handle');
  var treePane = document.getElementById('mqtt-tree-pane');
  var mainContainer = document.getElementById('mqtt-main');

  splitHandle.addEventListener('mousedown', function (e) {
    e.preventDefault();
    var startX = e.clientX;
    var startWidth = treePane.offsetWidth;
    var containerWidth = mainContainer.offsetWidth;

    function onMove(ev) {
      var dx = ev.clientX - startX;
      var newWidth = Math.max(200, Math.min(containerWidth - 200, startWidth + dx));
      treePane.style.width = newWidth + 'px';
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Save split position
      try {
        var pct = (treePane.offsetWidth / mainContainer.offsetWidth * 100).toFixed(1);
        var state = JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}');
        state.splitPct = pct;
        localStorage.setItem(UI_STATE_KEY, JSON.stringify(state));
      } catch (e) { /* ignore */ }
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Restore split position
  try {
    var uiState = JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}');
    if (uiState.splitPct) {
      treePane.style.width = uiState.splitPct + '%';
    }
  } catch (e) { /* ignore */ }

  // ── WS send helper ──
  function wsSend(msg) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ── beforeunload cleanup ──
  window.addEventListener('beforeunload', function () {
    if (connectionId) {
      // sendBeacon only supports POST, so we use a dedicated POST endpoint
      navigator.sendBeacon('/api/mqtt-explorer/disconnect/' + connectionId, '');
    }
  });

  // ── Public API ──
  window.MqttExplorer = {
    wsSend: wsSend,
    getConnectionId: function () { return connectionId; },
    getStatus: function () { return status; },
  };

  // ── Init ──
  loadProfiles();
  setStatus('disconnected');
})();
