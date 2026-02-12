// MQTT Explorer — Publish panel (form, templates localStorage, history)
(function () {
  'use strict';

  var TEMPLATES_KEY = 'mqttExplorerTemplates';

  var elToggle = document.getElementById('mqtt-publish-toggle');
  var elBody = document.getElementById('mqtt-publish-body');
  var elChevron = document.getElementById('mqtt-publish-chevron');
  var elTopic = document.getElementById('mqtt-pub-topic');
  var elPayload = document.getElementById('mqtt-pub-payload');
  var elQos = document.getElementById('mqtt-pub-qos');
  var elRetain = document.getElementById('mqtt-pub-retain');
  var elSendBtn = document.getElementById('mqtt-pub-send-btn');
  var elSaveTplBtn = document.getElementById('mqtt-pub-save-tpl-btn');
  var elTemplateSelect = document.getElementById('mqtt-pub-template-select');
  var elLoadTplBtn = document.getElementById('mqtt-pub-load-tpl-btn');
  var elDelTplBtn = document.getElementById('mqtt-pub-del-tpl-btn');

  var templates = [];
  var publishHistory = []; // in-memory only

  // ── Toggle panel ──
  var isOpen = false;
  elToggle.addEventListener('click', function () {
    isOpen = !isOpen;
    elBody.classList.toggle('hidden', !isOpen);
    elChevron.classList.toggle('open', isOpen);
  });

  // ── Publish ──
  elSendBtn.addEventListener('click', doPublish);

  elPayload.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.ctrlKey) {
      doPublish();
    }
  });

  function doPublish() {
    var connId = window.MqttExplorer.getConnectionId();
    if (!connId) return;

    var topic = elTopic.value.trim();
    if (!topic) { elTopic.focus(); return; }

    var payload = elPayload.value;
    var qos = parseInt(elQos.value, 10);
    var retain = elRetain.checked;

    fetch('/api/mqtt-explorer/' + connId + '/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: topic, payload: payload, qos: qos, retain: retain }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.error) {
          // Flash send button green
          elSendBtn.classList.add('bg-green-500/30');
          setTimeout(function () { elSendBtn.classList.remove('bg-green-500/30'); }, 300);

          // Add to history
          publishHistory.unshift({ topic: topic, payload: payload, qos: qos, retain: retain, ts: Date.now() });
          if (publishHistory.length > 50) publishHistory.pop();
        }
      })
      .catch(function () {});
  }

  // ── Templates ──
  function loadTemplates() {
    try {
      templates = JSON.parse(localStorage.getItem(TEMPLATES_KEY) || '[]');
    } catch (e) { templates = []; }
    renderTemplateSelect();
  }

  function saveTemplates() {
    try { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates)); } catch (e) { /* ignore */ }
  }

  function renderTemplateSelect() {
    elTemplateSelect.innerHTML = '<option value="">' + t('mqtt.no_templates') + '</option>';
    templates.forEach(function (tpl, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = tpl.name || tpl.topic;
      elTemplateSelect.appendChild(opt);
    });
  }

  elSaveTplBtn.addEventListener('click', function () {
    var topic = elTopic.value.trim();
    var payload = elPayload.value;
    if (!topic) { elTopic.focus(); return; }

    var name = prompt(t('mqtt.tpl_name'), topic);
    if (!name) return;

    templates.push({
      name: name,
      topic: topic,
      payload: payload,
      qos: parseInt(elQos.value, 10),
      retain: elRetain.checked,
    });
    saveTemplates();
    renderTemplateSelect();
  });

  elLoadTplBtn.addEventListener('click', function () {
    var idx = parseInt(elTemplateSelect.value, 10);
    if (isNaN(idx) || !templates[idx]) return;
    var tpl = templates[idx];
    elTopic.value = tpl.topic;
    elPayload.value = tpl.payload || '';
    elQos.value = String(tpl.qos || 0);
    elRetain.checked = !!tpl.retain;
  });

  elDelTplBtn.addEventListener('click', function () {
    var idx = parseInt(elTemplateSelect.value, 10);
    if (isNaN(idx) || !templates[idx]) return;
    templates.splice(idx, 1);
    saveTemplates();
    renderTemplateSelect();
  });

  // ── Fill topic from tree selection ──
  // Listen for tree selection to pre-fill the publish topic
  var origOnMessage = window.MqttExplorerDetail ? window.MqttExplorerDetail.onMessage : null;
  if (window.MqttExplorerDetail) {
    var _origOnMessage = window.MqttExplorerDetail.onMessage;
    window.MqttExplorerDetail.onMessage = function (msg) {
      _origOnMessage(msg);
      // Pre-fill publish topic if empty
      if (!elTopic.value.trim() && msg.topic) {
        elTopic.value = msg.topic;
      }
    };
  }

  // ── Init ──
  loadTemplates();
})();
