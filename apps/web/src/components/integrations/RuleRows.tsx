/**
 * A small table editor for rule lists (alarms, counters, thresholds) — one row per rule, one input per field.
 *
 * Important: values are kept in their real types (number, null) while editing, and the whole config is checked with
 *    the same core parser the server uses before saving. An empty optional field is `null`, never `''` — the parser
 *    rejects empty strings, so writing '' would turn "not set" into an error.
 */
import { fill, tr } from '../../i18n.js';

export type Cell = string | number | null | boolean | readonly string[] | { equals: string[] } | undefined;

export interface Column {
  key: string;
  label: string;
  kind: 'text' | 'nullableText' | 'number' | 'nullableNumber' | 'select' | 'activeWhen';
  options?: readonly string[];
  /** id of a <datalist> with suggestions (tag names) */
  list?: string;
}

interface Props<T extends object> {
  title: string;
  rows: readonly T[];
  columns: readonly Column[];
  onChange: (rows: T[]) => void;
  newRow: (index: number) => T;
  disabled: boolean;
}

function show(value: Cell, kind: Column['kind']): string {
  if (kind === 'activeWhen') return typeof value === 'object' && value !== null && 'equals' in value ? value.equals.join(', ') : '';
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isNaN(value) ? '' : String(value);
  return String(value);
}

function read(text: string, kind: Column['kind']): Cell {
  if (kind === 'activeWhen') {
    const words = text.split(',').map((word) => word.trim()).filter((word) => word !== '');
    return words.length === 0 ? 'truthy' : { equals: words };
  }
  if (kind === 'nullableText') return text.trim() === '' ? null : text;
  if (kind === 'nullableNumber') return text.trim() === '' ? null : Number(text);
  if (kind === 'number') return text.trim() === '' ? Number.NaN : Number(text);
  return text;
}

export function RuleRows<T extends object>({ title, rows, columns, onChange, newRow, disabled }: Props<T>): React.JSX.Element {
  const update = (index: number, key: string, value: Cell): void =>
    onChange(rows.map((row, at) => (at === index ? ({ ...row, [key]: value } as T) : row)));
  return (
    <fieldset className="rule-rows">
      <legend>{title}</legend>
      {rows.length > 0 && (
        <div className="table-scroll">
          <table className="integration-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key}>{column.label}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                // Keyed by position and count: removing a row remounts the rest so the number inputs show their new values
                <tr key={`${index}-${rows.length}`}>
                  {columns.map((column) => {
                    const value = (row as Record<string, Cell>)[column.key];
                    const label = fill(tr('{0} {1}번째 줄 {2}'), { 0: title, 1: index + 1, 2: column.label });
                    return (
                      <td key={column.key}>
                        {column.kind === 'select' ? (
                          <select aria-label={label} disabled={disabled} value={show(value, column.kind)} onChange={(event) => update(index, column.key, event.target.value)}>
                            {(column.options ?? []).map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        ) : (
                          column.kind === 'number' || column.kind === 'nullableNumber' ? (
                            // Numbers are read on blur: a half-typed "-" or "1." is not a number yet and must not be wiped
                            <input
                              aria-label={label}
                              disabled={disabled}
                              inputMode="decimal"
                              defaultValue={show(value, column.kind)}
                              onBlur={(event) => update(index, column.key, read(event.target.value, column.kind))}
                            />
                          ) : (
                            <input
                              aria-label={label}
                              disabled={disabled}
                              {...(column.list ? { list: column.list } : {})}
                              value={show(value, column.kind)}
                              onChange={(event) => update(index, column.key, read(event.target.value, column.kind))}
                            />
                          )
                        )}
                      </td>
                    );
                  })}
                  <td>
                    <button type="button" disabled={disabled} onClick={() => onChange(rows.filter((_, at) => at !== index))}>
                      {tr('빼기')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" disabled={disabled} onClick={() => onChange([...rows, newRow(rows.length + 1)])}>
        {fill(tr('{0} 더하기'), { 0: title })}
      </button>
    </fieldset>
  );
}
