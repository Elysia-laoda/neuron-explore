/* neuron-explore — 浏览器端：把「神经元探索」设置页挂进 DSH 设置（settings.section slot） */
(function () {
  var root = typeof window !== 'undefined' ? window : globalThis;
  if (!root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== 'function') return;
  root.__ModuleLoader__.load({
    id: 'neuron-explore',
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      var React = null;
      try { React = require('react') || null; } catch (e) { React = null; }
      var h = React ? React.createElement : null;

      var FIELDS = [
        { k: 'enabled', label: '启用', type: 'checkbox' },
        { k: 'mode', label: '模式', type: 'select', options: ['single', 'agent', 'fuse'] },
        { k: 'workers', label: '并行数', type: 'number' },
        { k: 'rounds', label: '固定轮数(0=自动)', type: 'number' },
        { k: 'noProgress', label: '卡住判定轮', type: 'number' },
        { k: 'maxRounds', label: '轮数上限(0=不限)', type: 'number' },
        { k: 'maxMinutes', label: '总时长上限(分钟,0=不限)', type: 'number' },
        { k: 'mid', label: '截断字数', type: 'number' },
        { k: 'tail', label: '投递字数', type: 'number' },
        { k: 'budget', label: '思考预算(0=不限)', type: 'number' },
        { k: 'baseUrl', label: '端点(留空=用DSH模型)', type: 'text' },
        { k: 'model', label: '模型(留空=用DSH模型)', type: 'text' },
        { k: 'apiKeyEnv', label: '密钥变量名(留空=用DSH)', type: 'text' },
        { k: 'judgeModel', label: '评审模型', type: 'text' },
        { k: 'judgeBaseUrl', label: '评审端点', type: 'text' },
        { k: 'judgeApiKeyEnv', label: '评审密钥变量名', type: 'text' }
      ];

      function Panel() {
        var s = React.useState(null), data = s[0], setData = s[1];
        var m = React.useState(''), msg = m[0], setMsg = m[1];
        React.useEffect(function () {
          fetch('/neuron-explore/config')
            .then(function (r) { return r.json(); })
            .then(function (j) { setData(j); })
            .catch(function (e) { setMsg('读取失败：' + e); });
        }, []);
        if (!data) return h('div', { style: { padding: 16, opacity: 0.75 } }, '加载中…');

        function set(k, v) { var n = Object.assign({}, data); n[k] = v; setData(n); }
        function save() {
          setMsg('保存中…');
          fetch('/neuron-explore/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(data)
          }).then(function (r) { return r.json(); })
            .then(function (j) { setMsg(j && j.ok ? '已保存（下一次工具调用生效）' : '保存失败：' + ((j && j.error) || '')); })
            .catch(function (e) { setMsg('保存失败：' + e); });
        }

        var rows = FIELDS.map(function (f) {
          var val = data[f.k];
          var el;
          if (f.type === 'checkbox') {
            el = h('input', { type: 'checkbox', checked: !!val, onChange: function (e) { set(f.k, e.target.checked); } });
          } else if (f.type === 'select') {
            el = h('select', { value: val || 'fuse', onChange: function (e) { set(f.k, e.target.value); } },
              f.options.map(function (o) { return h('option', { key: o, value: o }, o); }));
          } else if (f.type === 'number') {
            el = h('input', { type: 'number', value: val == null ? '' : val, onChange: function (e) { set(f.k, Number(e.target.value)); } });
          } else {
            el = h('input', { type: 'text', value: val == null ? '' : val, style: { width: 320 }, onChange: function (e) { set(f.k, e.target.value); } });
          }
          return h('label', { key: f.k, style: { display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' } },
            h('span', { style: { width: 120, opacity: 0.8 } }, f.label), el);
        });

        return h('div', { style: { padding: '12px 4px', maxWidth: 640 } },
          h('h3', { style: { margin: '0 0 8px' } }, '神经元探索'),
          h('p', { style: { opacity: 0.7, margin: '0 0 12px', fontSize: 13 } },
            '三个模式都会让多个 AI 并行思考并互相注入；单思考注入与融合式需要断点续写型模型（deepseek-v4.1-flash / glm-5.3），其余模型请只用 agent 模式。',
            '默认全部不限：轮数、总时长、思考预算填 0 即不设上限，由评审宣告“答案已完整”或“卡住不动”来结束。',
            '不填端点/模型时直接用你 DSH 里已经配好的默认模型，不需要额外密钥。'),
          rows,
          h('div', { style: { marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' } },
            h('button', { onClick: save }, '保存'),
            h('span', { style: { opacity: 0.75, fontSize: 13 } }, msg)),
          h('p', { style: { opacity: 0.55, marginTop: 12, fontSize: 12 } },
            '配置写入 ~/.dsh/neuron-explore.json（覆盖 cordis.patch.yml 中的同名项）。密钥只存环境变量名，不写入文件。'));
      }

      var inject = ['slots'];

      function apply(ctx) {
        if (!React || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') return;
        try {
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'neuron-explore',
              order: 46,
              label: function () { return '神经元探索'; }
            }, function () { return h(Panel, null); });
          });
          try { console.log('[neuron-explore] settings.section registered'); } catch (e) {}
        } catch (e) {
          try { console.error('[neuron-explore] settings.section failed', e); } catch (e2) {}
        }
      }

      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    }
  });
})();
