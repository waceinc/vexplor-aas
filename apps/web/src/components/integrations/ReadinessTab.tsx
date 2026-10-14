/**
 * Readiness — the integration checks INT-1…INT-5 (design §8): what in a file would make an export wrong or refused.
 *
 * Important: these are not lint findings. The lint catalogue is the submission contract; these checks only say what
 *    an ERP / MES export will do with the file (exclude a Type, refuse a BOM, leave an interval empty).
 */
import { useEffect, useState } from 'react';
import type { PackageDescription } from '../../api.js';
import { integrationApi, type ReadinessView } from '../../api/integration.js';
import { tr } from '../../i18n.js';
import { ErrorNote, PackagePicker, packageLabel } from './common.js';

interface Props {
  packages: readonly PackageDescription[];
}

export function ReadinessTab({ packages }: Props): React.JSX.Element {
  const [packageId, setPackageId] = useState<string>();
  const [view, setView] = useState<ReadinessView>();
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let alive = true;
    setView(undefined);
    setError(undefined);
    integrationApi
      .readiness(packageId)
      .then((next) => alive && setView(next))
      .catch((caught: unknown) => alive && setError(caught));
    return () => {
      alive = false;
    };
  }, [packageId]);

  const nameOf = (id: string): string => {
    const found = packages.find((item) => item.packageId === id);
    return found ? packageLabel(found) : id;
  };
  const withChecks = view?.items.filter((item) => item.checks.length > 0) ?? [];

  return (
    <div className="integration-tab">
      <PackagePicker packages={packages} value={packageId} onChange={setPackageId} allowAll />
      <ErrorNote error={error} />
      {view && withChecks.length === 0 && <p className="note ok">{tr('연동 준비 점검에 걸린 것이 없습니다.')}</p>}
      {withChecks.map((item) => (
        <section key={item.packageId}>
          <h3>{nameOf(item.packageId)}</h3>
          <ul className="readiness-list">
            {item.checks.map((check, index) => (
              <li key={`${check.id}-${index}`}>
                <span className={`state-chip ${check.severity === 'error' ? 'severity-error' : 'severity-warning'}`}>
                  {check.id} · {check.severity === 'error' ? tr('막힘') : tr('주의')}
                </span>{' '}
                {check.message}
                {check.pointer && <span className="dim mono"> · {check.pointer}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
