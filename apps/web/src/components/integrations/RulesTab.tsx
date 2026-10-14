/**
 * Rules — how values become states and events.
 *  - Server rules (admins): which words mean running / stopped / alarm / power off, time zone, day start, shifts.
 *  - Per-file rules (editors): the state tag, alarm / counter / threshold rules, the maintenance-mode tag.
 *
 * Important: one rule set judges both the daily bar and the events sent to MES (design D3). That is why the rules
 *    live on the server and not in each browser — two browsers with two rule sets gave two answers.
 * Important: saving sends `If-Match` with the revision that was loaded. On 412 (saved elsewhere first) the screen
 *    asks to reload; it never retries with the new revision, which would overwrite the other person's change.
 */
import {
  COUNTER_KINDS,
  MACHINE_STATES,
  defaultPackageIntegrationConfig,
  parsePackageIntegrationConfig,
  parseServerIntegrationConfig,
  type AlarmRule,
  type ConfigError,
  type CounterRule,
  type MachineState,
  type PackageIntegrationConfig,
  type ServerIntegrationConfig,
  type StateRules,
  type ThresholdRule,
} from '@aas/core';
import { useEffect, useState } from 'react';
import { api, type PackageDescription } from '../../api.js';
import { integrationApi, isStale } from '../../api/integration.js';
import { fill, tr } from '../../i18n.js';
import { ErrorNote, PackagePicker, StaleNote, splitList } from './common.js';
import { RuleRows } from './RuleRows.js';

export function stateLabel(state: MachineState): string {
  if (state === 'run') return tr('가동');
  if (state === 'stop') return tr('정지');
  if (state === 'alarm') return tr('알람');
  return tr('전원 꺼짐');
}

function Problems({ errors }: { errors: readonly ConfigError[] }): React.JSX.Element | null {
  if (errors.length === 0) return null;
  return (
    <ul className="note error" role="alert">
      {errors.map((item) => (
        <li key={`${item.path}-${item.message}`}>
          <span className="mono">{item.path}</span> {item.message}
        </li>
      ))}
    </ul>
  );
}

/** Four comma-list inputs, one per state */
function StateRuleInputs({ rules, disabled, onChange, prefix }: { rules: StateRules; disabled: boolean; onChange: (next: StateRules) => void; prefix: string }): React.JSX.Element {
  return (
    <div className="state-rules">
      {MACHINE_STATES.map((state) => (
        <label key={state}>
          <span className={`state-chip state-${state}`}>{stateLabel(state)}</span>
          <input
            aria-label={fill(tr('{0} {1} 규칙'), { 0: prefix, 1: stateLabel(state) })}
            disabled={disabled}
            defaultValue={rules[state].join(', ')}
            onBlur={(event) => onChange({ ...rules, [state]: splitList(event.target.value) })}
          />
        </label>
      ))}
    </div>
  );
}

interface Props {
  admin: boolean;
  edit: boolean;
  packages: readonly PackageDescription[];
}

export function RulesTab({ admin, edit, packages }: Props): React.JSX.Element {
  return (
    <div className="integration-tab">
      <ServerRules admin={admin} />
      <PackageRules edit={edit} packages={packages} />
    </div>
  );
}

function ServerRules({ admin }: { admin: boolean }): React.JSX.Element {
  const [loaded, setLoaded] = useState<{ value: ServerIntegrationConfig; revision: number }>();
  const [draft, setDraft] = useState<ServerIntegrationConfig>();
  const [errors, setErrors] = useState<ConfigError[]>([]);
  const [error, setError] = useState<unknown>();
  const [stale, setStale] = useState(false);
  const [saved, setSaved] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let alive = true;
    integrationApi
      .serverConfig()
      .then((next) => {
        if (!alive) return;
        setLoaded(next);
        setDraft(next.value);
      })
      .catch((caught: unknown) => alive && setError(caught));
    return () => {
      alive = false;
    };
  }, [generation]);

  const reload = (): void => {
    setStale(false);
    setError(undefined);
    setErrors([]);
    setGeneration((value) => value + 1);
  };

  const save = async (): Promise<void> => {
    if (!draft || !loaded) return;
    setSaved(false);
    setError(undefined);
    const parsed = parseServerIntegrationConfig(draft);
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors([]);
    try {
      const next = await integrationApi.saveServerConfig(parsed.value, loaded.revision);
      setLoaded(next);
      setDraft(next.value);
      setSaved(true);
    } catch (caught) {
      if (isStale(caught)) setStale(true);
      else setError(caught);
    }
  };

  return (
    <section>
      <h3>{tr('서버 공통 규칙')}</h3>
      {!admin && <p className="hint">{tr('관리자만 바꿀 수 있습니다. 모든 파일과 하루 상태 막대가 이 규칙을 사용합니다.')}</p>}
      <ErrorNote error={error} />
      {stale && <StaleNote onReload={reload} />}
      {draft && (
        <div key={`${generation}-${loaded?.revision ?? 0}`} className="integration-form">
          <p className="hint">{tr('값이 이 글자와 같으면 그 상태로 봅니다(쉼표로 나눔, 대소문자 · 공백 무시). 규칙에 없는 값은 「판정 못함」입니다.')}</p>
          <StateRuleInputs prefix={tr('서버')} rules={draft.stateRules} disabled={!admin} onChange={(stateRules) => setDraft({ ...draft, stateRules })} />
          <div className="row-buttons wrap">
            <label>
              <span>{tr('시간대')}</span>
              <input disabled={!admin} defaultValue={draft.timezone} onBlur={(event) => setDraft({ ...draft, timezone: event.target.value.trim() })} />
            </label>
            <label>
              <span>{tr('하루 시작 시각 (시)')}</span>
              <input disabled={!admin} inputMode="numeric" defaultValue={String(draft.dayStartHour)} onBlur={(event) => setDraft({ ...draft, dayStartHour: Number(event.target.value) })} />
            </label>
          </div>
          <RuleRows
            title={tr('근무조')}
            disabled={!admin}
            rows={draft.shifts}
            columns={[
              { key: 'name', label: tr('이름'), kind: 'text' },
              { key: 'start', label: tr('시작 (HH:MM)'), kind: 'text' },
              { key: 'end', label: tr('끝 (HH:MM)'), kind: 'text' },
            ]}
            newRow={(index) => ({ name: String.fromCharCode(64 + Math.min(index, 26)), start: '08:00', end: '20:00' })}
            onChange={(shifts) => setDraft({ ...draft, shifts })}
          />
          <Problems errors={errors} />
          {saved && <p className="note ok">{tr('저장했습니다. 다음 판정부터 이 규칙을 사용합니다.')}</p>}
          {admin && (
            <div className="row-buttons">
              <button type="button" className="primary" onClick={() => void save()}>
                {tr('서버 규칙 저장')}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function PackageRules({ edit, packages }: { edit: boolean; packages: readonly PackageDescription[] }): React.JSX.Element {
  const [packageId, setPackageId] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<PackageIntegrationConfig>();
  const [names, setNames] = useState<{ properties: string[]; interfaces: string[] }>({ properties: [], interfaces: [] });
  const [errors, setErrors] = useState<ConfigError[]>([]);
  const [error, setError] = useState<unknown>();
  const [stale, setStale] = useState(false);
  const [saved, setSaved] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    setDraft(undefined);
    setStale(false);
    setSaved(false);
    setErrors([]);
    setError(undefined);
    if (!packageId) return;
    let alive = true;
    integrationApi
      .packageConfig(packageId)
      .then((next) => {
        if (!alive) return;
        setRevision(next.revision);
        setDraft(next.value ?? defaultPackageIntegrationConfig());
      })
      .catch((caught: unknown) => alive && setError(caught));
    // Tag names for suggestions only — a file without collection simply gets no suggestions
    api
      .interfaces(packageId)
      .then((result) => {
        if (!alive) return;
        setNames({
          properties: [...new Set(result.interfaces.flatMap((item) => item.properties.map((property) => property.name)))],
          interfaces: result.interfaces.map((item) => item.name),
        });
      })
      .catch(() => alive && setNames({ properties: [], interfaces: [] }));
    return () => {
      alive = false;
    };
  }, [packageId, generation]);

  const save = async (): Promise<void> => {
    if (!draft || !packageId) return;
    setSaved(false);
    setError(undefined);
    const parsed = parsePackageIntegrationConfig(draft);
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors([]);
    try {
      const next = await integrationApi.savePackageConfig(packageId, parsed.value, revision);
      setRevision(next.revision);
      setDraft(next.value);
      setSaved(true);
    } catch (caught) {
      if (isStale(caught)) setStale(true);
      else setError(caught);
    }
  };

  const disabled = !edit;
  return (
    <section>
      <h3>{tr('파일별 규칙')}</h3>
      {!edit && <p className="hint">{tr('편집 권한이 있는 계정만 바꿀 수 있습니다.')}</p>}
      <PackagePicker packages={packages} value={packageId} onChange={setPackageId} />
      <ErrorNote error={error} />
      {stale && <StaleNote onReload={() => setGeneration((value) => value + 1)} />}
      <datalist id="integration-tags">
        {names.properties.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id="integration-interfaces">
        {names.interfaces.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {draft && (
        <div key={`${packageId}-${generation}-${revision}`} className="integration-form">
          <div className="row-buttons wrap">
            <label>
              <span>{tr('상태 태그')}</span>
              <input
                list="integration-tags"
                disabled={disabled}
                value={draft.state?.property ?? ''}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    state: event.target.value.trim() === '' ? null : { property: event.target.value, interfaceName: draft.state?.interfaceName ?? null, rules: draft.state?.rules ?? null },
                  })
                }
              />
            </label>
            <label>
              <span>{tr('연결 이름 (여러 연결에 같은 태그가 있을 때)')}</span>
              <input
                list="integration-interfaces"
                disabled={disabled || !draft.state}
                value={draft.state?.interfaceName ?? ''}
                onChange={(event) => draft.state && setDraft({ ...draft, state: { ...draft.state, interfaceName: event.target.value.trim() === '' ? null : event.target.value } })}
              />
            </label>
          </div>
          {draft.state && (
            <label className="check">
              <input
                type="checkbox"
                disabled={disabled}
                checked={draft.state.rules !== null}
                onChange={(event) => draft.state && setDraft({ ...draft, state: { ...draft.state, rules: event.target.checked ? { run: [], stop: [], alarm: [], off: [] } : null } })}
              />
              <span>{tr('이 파일만 따로 판정 규칙 쓰기 (끄면 서버 공통 규칙)')}</span>
            </label>
          )}
          {draft.state?.rules && (
            <StateRuleInputs prefix={tr('이 파일')} rules={draft.state.rules} disabled={disabled} onChange={(rules) => draft.state && setDraft({ ...draft, state: { ...draft.state, rules } })} />
          )}

          <RuleRows
            title={tr('알람 규칙')}
            disabled={disabled}
            rows={draft.alarms}
            columns={[
              { key: 'id', label: tr('이름(id)'), kind: 'text' },
              { key: 'property', label: tr('태그'), kind: 'text', list: 'integration-tags' },
              { key: 'activeWhen', label: tr('켜짐 값 (비우면 참/1)'), kind: 'activeWhen' },
              { key: 'codeProperty', label: tr('코드 태그'), kind: 'nullableText', list: 'integration-tags' },
              { key: 'textProperty', label: tr('문구 태그'), kind: 'nullableText', list: 'integration-tags' },
              { key: 'severity', label: tr('심각도'), kind: 'nullableText' },
              { key: 'raiseSamples', label: tr('켜짐 확정 횟수'), kind: 'number' },
              { key: 'clearSamples', label: tr('꺼짐 확정 횟수'), kind: 'number' },
            ]}
            newRow={(index): AlarmRule => ({ id: `alarm-${index}`, property: '', activeWhen: 'truthy', codeProperty: null, textProperty: null, severity: null, raiseSamples: 1, clearSamples: 1, maintenanceIds: [] })}
            onChange={(alarms) => setDraft({ ...draft, alarms })}
          />
          <RuleRows
            title={tr('계수기')}
            disabled={disabled}
            rows={draft.counters}
            columns={[
              { key: 'id', label: tr('이름(id)'), kind: 'text' },
              { key: 'property', label: tr('태그'), kind: 'text', list: 'integration-tags' },
              { key: 'kind', label: tr('종류'), kind: 'select', options: COUNTER_KINDS },
              { key: 'unit', label: tr('단위'), kind: 'nullableText' },
              { key: 'max', label: tr('최댓값 (넘으면 0부터)'), kind: 'nullableNumber' },
              { key: 'maxRatePerHour', label: tr('시간당 최대 증가'), kind: 'nullableNumber' },
            ]}
            newRow={(index): CounterRule => ({ id: `counter-${index}`, property: '', kind: 'total', unit: null, max: null, maxRatePerHour: null })}
            onChange={(counters) => setDraft({ ...draft, counters })}
          />
          <RuleRows
            title={tr('한계값')}
            disabled={disabled}
            rows={draft.thresholds}
            columns={[
              { key: 'id', label: tr('이름(id)'), kind: 'text' },
              { key: 'property', label: tr('태그'), kind: 'text', list: 'integration-tags' },
              { key: 'direction', label: tr('방향'), kind: 'select', options: ['above', 'below'] },
              { key: 'limit', label: tr('한계'), kind: 'number' },
              { key: 'hysteresis', label: tr('되돌아옴 여유'), kind: 'number' },
              { key: 'unit', label: tr('단위'), kind: 'nullableText' },
              { key: 'severity', label: tr('심각도'), kind: 'nullableText' },
              { key: 'raiseSamples', label: tr('넘음 확정 횟수'), kind: 'number' },
              { key: 'clearSamples', label: tr('되돌아옴 확정 횟수'), kind: 'number' },
            ]}
            newRow={(index): ThresholdRule => ({ id: `threshold-${index}`, property: '', direction: 'above', limit: 0, hysteresis: 0, unit: null, severity: null, raiseSamples: 1, clearSamples: 1 })}
            onChange={(thresholds) => setDraft({ ...draft, thresholds })}
          />
          <div className="row-buttons wrap">
            <label>
              <span>{tr('보전 중 표시 태그 (참이면 사건에 suppressed 표시)')}</span>
              <input
                list="integration-tags"
                disabled={disabled}
                value={draft.suppressProperty ?? ''}
                onChange={(event) => setDraft({ ...draft, suppressProperty: event.target.value.trim() === '' ? null : event.target.value })}
              />
            </label>
            <label>
              <span>{tr('연결 끊김 판정 (연속 실패 횟수)')}</span>
              <input
                disabled={disabled}
                inputMode="numeric"
                defaultValue={String(draft.connection.lostAfterFailures)}
                onBlur={(event) => setDraft({ ...draft, connection: { lostAfterFailures: Number(event.target.value) } })}
              />
            </label>
          </div>
          <Problems errors={errors} />
          {saved && <p className="note ok">{tr('저장했습니다. 다음 수집 주기부터 이 규칙으로 판정합니다.')}</p>}
          {edit && (
            <div className="row-buttons">
              <button type="button" className="primary" onClick={() => void save()}>
                {tr('파일 규칙 저장')}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
