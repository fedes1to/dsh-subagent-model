window.__ModuleLoader__.load({
  id: 'dsh-subagent-model',
  factory: (require) => {
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')
    const { useState } = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const { SettingsForm, SettingsFormModel, SettingsValueField, Switch } = require(
      '@deepseek-ai/dsh-client-ui-primitives',
    )

    /**
     * Subagent-model settings page. Registers a Settings section while the Host
     * serves the `subagent-model` namespace, so a deployment that never composed
     * this plugin shows no trace of it. Saves write the profile's volatile
     * config; the host half reads those fields on every delegation, so a save
     * applies to the next subagent or teammate without a restart.
     */
    const NS = 'settings.subagentModel'

    /** Profile entry id this page edits. Matches the bundle patch row. */
    const ENTRY = 'subagent-model'

    const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session']

    const STYLE_ID = 'dsh-subagent-model/settings.css'
    if (
      typeof document !== 'undefined' &&
      document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-subagent-model'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = [
        '.dsh-sam-card{border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.25));border-radius:var(--dsw-radius-lg,10px);padding:12px 14px;display:flex;flex-direction:column;gap:12px}',
        '.dsh-sam-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
        '.dsh-sam-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);margin:0}',
        '.dsh-sam-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}',
        '.dsh-sam-col{display:flex;flex-direction:column;gap:4px;min-width:0}',
        '.dsh-sam-label{font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}',
        '.dsh-sam-select,.dsh-sam-input{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.35));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit);padding:6px 10px;font:inherit;font-size:13px}',
        '.dsh-sam-btn{border:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.35));border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary,inherit);padding:6px 10px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
        '.dsh-sam-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12))}',
        '.dsh-sam-btn:disabled{opacity:.5;cursor:default}',
        '.dsh-sam-link{background:none;border:0;padding:0;color:var(--dsw-alias-brand-primary,#4d6bfe);font:inherit;font-size:12px;cursor:pointer}',
        '.dsh-sam-member{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 8px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.08));font-size:13px}',
        '.dsh-sam-member-info{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dsh-sam-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,inherit);opacity:.8}',
        '.dsh-sam-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d)}',
        '.dsh-sam-badge{font-size:11px;padding:2px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.15));color:var(--dsw-alias-label-secondary,inherit)}',
      ].join('')
      document.head.appendChild(tag)
    }

    const en = {
      nav: 'Subagent model',
      description: 'Choose the model delegated subagents and teammates run on. Saves apply to new delegations.',
      enabled: 'Enable subagent model routing',
      enabledHint: 'When off, delegated children inherit the parent agent route.',
      defaultRouteTitle: 'Default child route',
      pickerProvider: 'Catalog provider',
      pickerModel: 'Catalog model',
      pickerEffort: 'Catalog reasoning effort',
      pickerNone: '(Inherit parent / custom)',
      pickerCustom: '(Custom value)',
      pickerModelDefault: '(Model default)',
      catalogLoading: 'Loading available models…',
      catalogFailed: 'Could not load model catalog.',
      catalogRetry: 'Retry',
      provider: 'Provider',
      providerHint: 'Provider id for the default child route. Leave blank to inherit the parent.',
      model: 'Model',
      modelHint: 'Model id within the provider (for example gemini-4-hydrogen).',
      reasoningEffort: 'Reasoning effort',
      reasoningEffortHint: 'Optional effort passed to the child (for example low, medium, high, xhigh, off).',
      providers: 'Delegation providers',
      providersHint: 'Comma-separated subagent providers stamped with the default route (default: spawn). Add fork to remap fork children too.',
      membersTitle: 'Teammate overrides',
      membersHint: 'Map an Agent Teams teammate name (lower-kebab-case) to its own route. Teammate overrides apply even to fork teammates.',
      membersEmpty: 'No teammate overrides — all teammates use the default route.',
      memberName: 'Teammate name',
      memberRoute: 'Route (provider/model)',
      memberEffort: 'Effort (optional)',
      memberAdd: 'Add',
      memberRemove: 'Remove',
      memberInvalidName: 'Teammate name must be lower-kebab-case (for example adversary).',
      memberInvalidRoute: 'Route must be <provider>/<model>.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      invalid: 'Enter a valid value, or leave blank to use the default.',
    }

    const zh = {
      nav: '子智能体模型',
      description: '设置子智能体和队友默认使用的模型。保存后对新的委托立即生效。',
      enabled: '启用子智能体模型路由',
      enabledHint: '关闭后，委托的子任务会继承父智能体的模型。',
      defaultRouteTitle: '默认子智能体路由',
      pickerProvider: '目录提供方',
      pickerModel: '目录模型',
      pickerEffort: '目录推理强度',
      pickerNone: '（继承父级 / 自定义）',
      pickerCustom: '（自定义值）',
      pickerModelDefault: '（模型默认）',
      catalogLoading: '正在加载可用模型…',
      catalogFailed: '无法加载模型目录。',
      catalogRetry: '重试',
      provider: '提供方',
      providerHint: '默认子路由的提供方 ID。留空表示继承父智能体。',
      model: '模型',
      modelHint: '提供方下的模型 ID（例如 gemini-4-hydrogen）。',
      reasoningEffort: '推理强度',
      reasoningEffortHint: '传递给子智能体的可选推理强度（例如 low、medium、high、xhigh、off）。',
      providers: '生效的委托类型',
      providersHint: '逗号分隔的子智能体提供方名称（默认：spawn）。加入 fork 也会重映射分叉子任务。',
      membersTitle: '队友模型覆盖',
      membersHint: '为 Agent Teams 的指定队友（小写短横线命名）设置单独模型。队友覆盖同样适用于 fork 队友。',
      membersEmpty: '暂无队友覆盖——所有队友均使用默认路由。',
      memberName: '队友名称',
      memberRoute: '路由（provider/model）',
      memberEffort: '推理强度（可选）',
      memberAdd: '添加',
      memberRemove: '移除',
      memberInvalidName: '队友名称须为小写短横线格式（例如 adversary）。',
      memberInvalidRoute: '路由格式须为 <provider>/<model>。',
      overridden: '已覆盖',
      reset: '恢复默认',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      invalid: '请填写有效的值，留空表示使用默认值。',
    }

    /** Trim optional text; blank clears the override. */
    function textField(field) {
      return {
        field,
        format: (value) => (typeof value === 'string' ? value : ''),
        parse: (text) => {
          const trimmed = text.trim()
          return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
        },
      }
    }

    /** Switch staged as "true" / "false". */
    function booleanField(field) {
      return {
        field,
        format: (value) => (value === false ? 'false' : 'true'),
        parse: (text) => ({ kind: 'set', value: text !== 'false' }),
      }
    }

    /** Comma-separated list of subagent provider names; blank resets to default. */
    function providersField() {
      return {
        field: 'providers',
        format: (value) => (Array.isArray(value) ? value.join(', ') : ''),
        parse: (text) => {
          const list = text
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item !== '')
          return list.length === 0 ? { kind: 'clear' } : { kind: 'set', value: list }
        },
      }
    }

    /** Normalize one route object or `"provider/model"` string. */
    function normalizeMemberRoute(value) {
      if (typeof value === 'string') {
        const text = value.trim()
        const slash = text.indexOf('/')
        if (slash <= 0 || slash === text.length - 1) return undefined
        return { provider: text.slice(0, slash), model: text.slice(slash + 1) }
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
        const model = typeof value.model === 'string' ? value.model.trim() : ''
        if (provider === '' || model === '') return undefined
        const effort =
          typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim() !== ''
            ? value.reasoningEffort.trim()
            : undefined
        return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
      }
      return undefined
    }

    /** Canonicalize a members object into sorted `{ [name]: route }` entries. */
    function normalizeMembersObject(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
      const out = {}
      for (const key of Object.keys(value).sort()) {
        const route = normalizeMemberRoute(value[key])
        if (route !== undefined) out[key] = route
      }
      return out
    }

    /** Serialize members canonically for SettingsFormModel staging. */
    function serializeMembers(value) {
      const normalized = normalizeMembersObject(value)
      return Object.keys(normalized).length === 0 ? '' : JSON.stringify(normalized)
    }

    /** Parse staged members text back into an object. */
    function parseMembersText(text) {
      if (typeof text !== 'string' || text.trim() === '') return {}
      try {
        return normalizeMembersObject(JSON.parse(text))
      } catch {
        return undefined
      }
    }

    /** Teammate route map stored as canonical JSON in the staged form. */
    function membersField() {
      return {
        field: 'members',
        format: (value) => serializeMembers(value),
        parse: (text) => {
          const parsed = parseMembersText(text)
          if (parsed === undefined) return undefined
          return Object.keys(parsed).length === 0 ? { kind: 'clear' } : { kind: 'set', value: parsed }
        },
      }
    }

    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    /** One text field, drawn by the shared SettingsValueField primitive. */
    function ValueField(props) {
      return jsx(SettingsValueField, {
        id: props.id,
        label: props.label,
        hint: props.hint,
        placeholder: props.placeholder,
        overriddenLabel: props.t('overridden'),
        resetLabel: props.t('reset'),
        invalidLabel: props.t('invalid'),
        disabled: props.disabled,
        text: props.value.text,
        overridden: props.value.overridden,
        invalid: props.value.invalid,
        onEdit: props.onEdit,
        onReset: props.onReset,
      })
    }

    /** A labelled switch. Resetting clears the override so the default returns. */
    function ToggleField(props) {
      const on = props.value.text !== 'false'
      return jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 4 },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
            children: [
              jsx('label', { htmlFor: props.id, children: props.label }),
              jsx(Switch, {
                checked: on,
                disabled: props.disabled,
                label: props.label,
                onChange: (checked) => props.onEdit(checked ? 'true' : 'false'),
              }),
            ],
          }),
          jsx('p', { className: 'dsh-sam-hint', children: props.hint }),
          props.value.overridden
            ? jsx('div', {
                children: jsx('button', {
                  type: 'button',
                  className: 'dsh-sam-link',
                  disabled: props.disabled,
                  onClick: props.onReset,
                  children: props.t('reset'),
                }),
              })
            : null,
        ],
      })
    }

    /**
     * Quick provider/model/effort dropdowns backed by the live adapter catalog.
     * Selecting here writes straight into the `provider`, `model`, and
     * `reasoningEffort` fields of the staged form.
     */
    function CatalogPicker(props) {
      const { t, groups, status, provider, model, reasoningEffort, disabled, onPick } = props
      if (status === 'loading') {
        return jsx('p', { className: 'dsh-sam-hint', role: 'status', children: t('catalogLoading') })
      }
      if (status === 'error') {
        return jsxs('div', {
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
          children: [
            jsx('p', { className: 'dsh-sam-error', role: 'alert', children: t('catalogFailed') }),
            jsx('button', {
              type: 'button',
              className: 'dsh-sam-link',
              onClick: props.onRetry,
              children: t('catalogRetry'),
            }),
          ],
        })
      }
      if (groups.length === 0) return null

      const selectedGroup = groups.find((group) => group.id === provider)
      const models = selectedGroup?.models ?? []
      const selectedModel = models.find((entry) => entry.id === model)
      const efforts = selectedModel?.reasoning?.efforts ?? []
      const hasCustomProvider = provider !== '' && selectedGroup === undefined
      const hasCustomModel = model !== '' && selectedModel === undefined
      const hasCustomEffort = reasoningEffort !== '' && !efforts.some((entry) => entry.id === reasoningEffort)

      const providerSelectValue = provider === '' ? '' : selectedGroup !== undefined ? provider : '__custom__'
      const modelSelectValue = model === '' ? '' : selectedModel !== undefined ? model : '__custom__'

      return jsxs('div', {
        className: 'dsh-sam-row',
        children: [
          jsxs('div', {
            className: 'dsh-sam-col',
            children: [
              jsx('label', { className: 'dsh-sam-label', htmlFor: 'subagent-model-cat-provider', children: t('pickerProvider') }),
              jsxs('select', {
                id: 'subagent-model-cat-provider',
                className: 'dsh-sam-select',
                disabled,
                value: providerSelectValue,
                onChange: (event) => {
                  const nextProvider = event.target.value
                  if (nextProvider === '' || nextProvider === '__custom__') {
                    if (nextProvider === '') onPick('', '', '')
                    return
                  }
                  const nextGroup = groups.find((group) => group.id === nextProvider)
                  const firstModel = nextGroup?.models?.[0]?.id ?? ''
                  onPick(nextProvider, firstModel, '')
                },
                children: [
                  jsx('option', { value: '', children: t('pickerNone') }),
                  hasCustomProvider ? jsx('option', { value: '__custom__', children: `${t('pickerCustom')}: ${provider}` }) : null,
                  groups.map((group) => jsx('option', { value: group.id, children: `${group.name} (${group.id})` }, group.id)),
                ],
              }),
            ],
          }),
          jsxs('div', {
            className: 'dsh-sam-col',
            children: [
              jsx('label', { className: 'dsh-sam-label', htmlFor: 'subagent-model-cat-model', children: t('pickerModel') }),
              jsxs('select', {
                id: 'subagent-model-cat-model',
                className: 'dsh-sam-select',
                disabled: disabled || selectedGroup === undefined,
                value: modelSelectValue,
                onChange: (event) => {
                  const nextModel = event.target.value
                  if (nextModel === '__custom__') return
                  onPick(provider, nextModel, '')
                },
                children: [
                  model === '' ? jsx('option', { value: '', children: t('pickerNone') }) : null,
                  hasCustomModel ? jsx('option', { value: '__custom__', children: `${t('pickerCustom')}: ${model}` }) : null,
                  models.map((entry) =>
                    jsx('option', { value: entry.id, children: entry.name === entry.id ? entry.id : `${entry.name} (${entry.id})` }, entry.id),
                  ),
                ],
              }),
            ],
          }),
          efforts.length > 0 || hasCustomEffort
            ? jsxs('div', {
                className: 'dsh-sam-col',
                children: [
                  jsx('label', { className: 'dsh-sam-label', htmlFor: 'subagent-model-cat-effort', children: t('pickerEffort') }),
                  jsxs('select', {
                    id: 'subagent-model-cat-effort',
                    className: 'dsh-sam-select',
                    disabled,
                    value: reasoningEffort,
                    onChange: (event) => {
                      onPick(provider, model, event.target.value)
                    },
                    children: [
                      jsx('option', { value: '', children: t('pickerModelDefault') }),
                      hasCustomEffort ? jsx('option', { value: reasoningEffort, children: reasoningEffort }) : null,
                      efforts.map((effort) =>
                        jsx('option', { value: effort.id, children: effort.name ?? effort.id }, effort.id),
                      ),
                    ],
                  }),
                ],
              })
            : null,
        ],
      })
    }

    /** Per-teammate route editor backed by the staged `members` field. */
    function MembersEditor(props) {
      const { t, field, groups, disabled, onEdit, onReset } = props
      const [memberName, setMemberName] = useState('')
      const [routeInput, setRouteInput] = useState('')
      const [effortInput, setEffortInput] = useState('')
      const [localError, setLocalError] = useState('')

      const currentMap = parseMembersText(field.text) ?? {}
      const entries = Object.entries(currentMap)

      const catalogRoutes = groups.flatMap((group) =>
        group.models.map((entry) => ({
          value: `${group.id}/${entry.id}`,
          label: `${group.name} / ${entry.name === entry.id ? entry.id : `${entry.name} (${entry.id})`}`,
        })),
      )

      const handleAdd = () => {
        const cleanName = memberName.trim()
        if (!/^[a-z][a-z0-9-]*$/u.test(cleanName)) {
          setLocalError(t('memberInvalidName'))
          return
        }
        const parsedRoute = normalizeMemberRoute(routeInput)
        if (parsedRoute === undefined) {
          setLocalError(t('memberInvalidRoute'))
          return
        }
        const cleanEffort = effortInput.trim()
        const nextRoute = {
          ...parsedRoute,
          ...(cleanEffort === '' ? {} : { reasoningEffort: cleanEffort }),
        }
        const nextMap = { ...currentMap, [cleanName]: nextRoute }
        setLocalError('')
        setMemberName('')
        setRouteInput('')
        setEffortInput('')
        onEdit(serializeMembers(nextMap))
      }

      const handleRemove = (nameToRemove) => {
        const nextMap = { ...currentMap }
        delete nextMap[nameToRemove]
        onEdit(serializeMembers(nextMap))
      }

      return jsxs('div', {
        className: 'dsh-sam-card',
        children: [
          jsxs('div', {
            className: 'dsh-sam-card-head',
            children: [
              jsx('h4', { className: 'dsh-sam-card-title', children: t('membersTitle') }),
              field.overridden
                ? jsxs('div', {
                    style: { display: 'flex', alignItems: 'center', gap: 8 },
                    children: [
                      jsx('span', { className: 'dsh-sam-badge', children: t('overridden') }),
                      jsx('button', {
                        type: 'button',
                        className: 'dsh-sam-link',
                        disabled,
                        onClick: onReset,
                        children: t('reset'),
                      }),
                    ],
                  })
                : null,
            ],
          }),
          jsx('p', { className: 'dsh-sam-hint', children: t('membersHint') }),
          entries.length === 0
            ? jsx('p', { className: 'dsh-sam-hint', children: t('membersEmpty') })
            : jsxs('div', {
                style: { display: 'flex', flexDirection: 'column', gap: 6 },
                children: entries.map(([name, route]) =>
                  jsxs(
                    'div',
                    {
                      className: 'dsh-sam-member',
                      children: [
                        jsx('span', {
                          className: 'dsh-sam-member-info',
                          children: `${name} → ${route.provider}/${route.model}${route.reasoningEffort ? ` · ${route.reasoningEffort}` : ''}`,
                        }),
                        jsx('button', {
                          type: 'button',
                          className: 'dsh-sam-btn',
                          disabled,
                          onClick: () => handleRemove(name),
                          children: t('memberRemove'),
                        }),
                      ],
                    },
                    name,
                  ),
                ),
              }),
          jsxs('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 },
            children: [
              catalogRoutes.length > 0
                ? jsxs('select', {
                    className: 'dsh-sam-select',
                    disabled,
                    value: catalogRoutes.some((item) => item.value === routeInput.trim()) ? routeInput.trim() : '',
                    onChange: (event) => {
                      if (event.target.value !== '') {
                        setRouteInput(event.target.value)
                        setLocalError('')
                      }
                    },
                    children: [
                      jsx('option', { value: '', children: t('memberRoute') }),
                      catalogRoutes.map((item) => jsx('option', { value: item.value, children: item.label }, item.value)),
                    ],
                  })
                : null,
              jsxs('div', {
                style: { display: 'grid', gridTemplateColumns: 'minmax(110px, 1fr) minmax(160px, 1.6fr) minmax(90px, .8fr) auto', gap: 8, alignItems: 'center' },
                children: [
                  jsx('input', {
                    type: 'text',
                    className: 'dsh-sam-input',
                    disabled,
                    placeholder: t('memberName'),
                    value: memberName,
                    onChange: (event) => {
                      setMemberName(event.target.value)
                      if (localError !== '') setLocalError('')
                    },
                  }),
                  jsx('input', {
                    type: 'text',
                    className: 'dsh-sam-input',
                    disabled,
                    placeholder: t('memberRoute'),
                    value: routeInput,
                    onChange: (event) => {
                      setRouteInput(event.target.value)
                      if (localError !== '') setLocalError('')
                    },
                  }),
                  jsx('input', {
                    type: 'text',
                    className: 'dsh-sam-input',
                    disabled,
                    placeholder: t('memberEffort'),
                    value: effortInput,
                    onChange: (event) => setEffortInput(event.target.value),
                  }),
                  jsx('button', {
                    type: 'button',
                    className: 'dsh-sam-btn',
                    disabled,
                    onClick: handleAdd,
                    children: t('memberAdd'),
                  }),
                ],
              }),
              localError !== '' ? jsx('p', { className: 'dsh-sam-error', children: localError }) : null,
            ],
          }),
        ],
      })
    }

    /** The section body. */
    function SubagentModelSection(props) {
      const state = props.useSubagentModel((snapshot) => snapshot)
      const disabled = !state.writable || state.saving
      const textInput = (field, id, placeholder) =>
        jsx(ValueField, {
          t: props.t,
          id,
          label: props.t(field),
          hint: props.t(`${field}Hint`),
          placeholder,
          value: state[field],
          disabled,
          onEdit: (text) => props.edit(field, text),
          onReset: () => props.resetField(field),
        })

      return jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 580 },
        children: [
          jsx('p', { style: { margin: 0, opacity: 0.72 }, children: props.t('description') }),
          jsx(SettingsForm, {
            labels: formLabels(props.t),
            state,
            onSave: props.save,
            onDiscard: props.discard,
            children: jsxs('div', {
              style: { display: 'flex', flexDirection: 'column', gap: 16 },
              children: [
                jsx(ToggleField, {
                  t: props.t,
                  id: 'subagent-model-enabled',
                  label: props.t('enabled'),
                  hint: props.t('enabledHint'),
                  value: state.enabled,
                  disabled,
                  onEdit: (text) => props.edit('enabled', text),
                  onReset: () => props.resetField('enabled'),
                }),
                jsxs('div', {
                  className: 'dsh-sam-card',
                  children: [
                    jsx('h4', { className: 'dsh-sam-card-title', children: props.t('defaultRouteTitle') }),
                    jsx(CatalogPicker, {
                      t: props.t,
                      groups: state.catalogGroups,
                      status: state.catalogStatus,
                      provider: state.provider.text.trim(),
                      model: state.model.text.trim(),
                      reasoningEffort: state.reasoningEffort.text.trim(),
                      disabled,
                      onRetry: props.retryCatalog,
                      onPick: (nextProvider, nextModel, nextEffort) => {
                        props.edit('provider', nextProvider)
                        props.edit('model', nextModel)
                        props.edit('reasoningEffort', nextEffort)
                      },
                    }),
                    textInput('provider', 'subagent-model-provider', 'antigravity'),
                    textInput('model', 'subagent-model-model', 'gemini-4-hydrogen'),
                    textInput('reasoningEffort', 'subagent-model-effort', 'high'),
                  ],
                }),
                textInput('providers', 'subagent-model-providers', 'spawn'),
                jsx(MembersEditor, {
                  t: props.t,
                  field: state.members,
                  groups: state.catalogGroups,
                  disabled,
                  onEdit: (text) => props.edit('members', text),
                  onReset: () => props.resetField('members'),
                }),
              ],
            }),
          }),
        ],
      })
    }

    /** Staged form over the `subagent-model` namespace + live adapter catalog. */
    class SubagentModelController {
      catalogGroups = []
      catalogStatus = 'idle'
      catalogGeneration = 0
      disposed = false

      /** @param {object} scope the bound settings scope. @param {object} ctx browser plugin context. */
      constructor(scope, ctx) {
        this.ctx = ctx
        this.form = new SettingsFormModel(scope, [
          booleanField('enabled'),
          textField('provider'),
          textField('model'),
          textField('reasoningEffort'),
          providersField(),
          membersField(),
        ])
        this.formStore = this.form.bind(() => this.formProjection())
        this.store = createSnapshotStore(this.projection())
        this.unsubscribe = this.formStore.subscribe(() => this.publish())
        this.loadCatalog()
      }

      formProjection() {
        return {
          ...this.form.shell(),
          enabled: this.form.field('enabled'),
          provider: this.form.field('provider'),
          model: this.form.field('model'),
          reasoningEffort: this.form.field('reasoningEffort'),
          providers: this.form.field('providers'),
          members: this.form.field('members'),
        }
      }

      projection() {
        return {
          ...this.formStore.getSnapshot(),
          catalogGroups: this.catalogGroups,
          catalogStatus: this.catalogStatus,
        }
      }

      publish() {
        if (!this.disposed) this.store.set(this.projection())
      }

      refreshCatalog() {
        if (this.disposed) return
        this.catalogGeneration += 1
        this.catalogStatus = 'idle'
        this.loadCatalog()
      }

      resetConnection() {
        if (this.disposed) return
        this.catalogGroups = []
        this.refreshCatalog()
      }

      async loadCatalog() {
        if (this.disposed || this.catalogStatus === 'loading') return
        const generation = this.catalogGeneration
        this.catalogStatus = 'loading'
        this.publish()
        try {
          const response = await this.ctx.remote.session.modelCatalog()
          if (this.disposed || generation !== this.catalogGeneration) return
          if (response?.ok) {
            this.catalogGroups = response.value?.groups ?? []
            this.catalogStatus = 'ready'
          } else {
            this.catalogStatus = 'error'
          }
        } catch {
          if (this.disposed || generation !== this.catalogGeneration) return
          this.catalogStatus = 'error'
        }
        this.publish()
      }

      inject() {
        return {
          hooks: { subagentModel: this.store },
          ...this.form.actions(),
          retryCatalog: () => this.loadCatalog(),
        }
      }

      dispose() {
        this.disposed = true
        this.catalogGeneration += 1
        this.unsubscribe()
        this.form.dispose()
      }
    }

    /**
     * Mount the page while the Host serves the namespace.
     * @param {object} ctx the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'subagent-model: settings copy')
      const t = ctx.locale.bind(NS)
      const card = new SubagentModelController(ctx.configForms.get(ENTRY), ctx)
      ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => card.refreshCatalog()), 'subagent-model: adapter invalidations')
      ctx.effect(() => ctx.remote.$on('settings/document-updated', () => card.refreshCatalog()), 'subagent-model: settings invalidations')
      ctx.effect(() => ctx.on('connection/reset', () => card.resetConnection()), 'subagent-model: connection generation')
      ctx.effect(() => () => card.dispose(), 'subagent-model: settings form')
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY], () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'subagent-model',
                  order: 86,
                  label: () => t('nav'),
                  locale: NS,
                  inject: () => card.inject(),
                },
                SubagentModelSection,
              ),
            ),
          ),
        'subagent-model: settings section',
      )
    }

    return { NS, apply, inject }
  },
})
