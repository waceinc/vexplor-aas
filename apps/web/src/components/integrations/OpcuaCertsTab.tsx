/**
 * OPC UA client certificates — a secure OPC UA server rejects an unknown client (an MES, UaExpert) until an admin
 * trusts its certificate here (design §7).
 *
 * Important: trust only a certificate whose thumbprint you compared with the one the client shows. Trusting by name
 *    alone lets any machine on the network that copies the name connect.
 */
import { useEffect, useState } from 'react';
import { integrationApi, type OpcuaCertificate } from '../../api/integration.js';
import { fill, tr } from '../../i18n.js';
import { ErrorNote, when } from './common.js';

export function OpcuaCertsTab(): React.JSX.Element {
  const [lists, setLists] = useState<{ trusted: OpcuaCertificate[]; rejected: OpcuaCertificate[] }>();
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<string>();
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let alive = true;
    integrationApi
      .opcuaCertificates()
      .then((next) => alive && setLists(next))
      .catch((caught: unknown) => alive && setError(caught));
    return () => {
      alive = false;
    };
  }, [generation]);

  const trust = async (certificate: OpcuaCertificate): Promise<void> => {
    if (!window.confirm(fill(tr('지문 {0} 인증서를 믿습니다. 클라이언트 화면에 보이는 지문과 같은지 확인하셨습니까?'), { 0: certificate.thumbprint }))) return;
    setError(undefined);
    try {
      await integrationApi.trustCertificate(certificate.thumbprint);
      setNotice(fill(tr('{0} 을(를) 믿는 인증서로 옮겼습니다. 클라이언트가 다시 접속하면 들어옵니다.'), { 0: certificate.subject ?? certificate.thumbprint }));
      setGeneration((value) => value + 1);
    } catch (caught) {
      setError(caught);
    }
  };

  const table = (items: readonly OpcuaCertificate[], rejected: boolean): React.JSX.Element =>
    items.length === 0 ? (
      <p className="hint">{tr('없습니다.')}</p>
    ) : (
      <div className="table-scroll">
        <table className="integration-table">
          <thead>
            <tr>
              <th>{tr('이름')}</th>
              <th>{tr('지문 (SHA-1)')}</th>
              <th>{tr('만료')}</th>
              {rejected && <th />}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.thumbprint}>
                <td>{item.subject ?? '—'}</td>
                <td className="mono wrap">{item.thumbprint}</td>
                <td>{when(item.notAfter)}</td>
                {rejected && (
                  <td>
                    <button type="button" onClick={() => void trust(item)}>
                      {tr('믿기')}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <div className="integration-tab">
      <p className="hint">{tr('처음 접속한 클라이언트의 인증서는 「거절됨」에 쌓입니다. 지문을 확인한 뒤 믿으면 다음 접속부터 들어옵니다.')}</p>
      <ErrorNote error={error} />
      {notice && <p className="note ok">{notice}</p>}
      {lists && (
        <>
          <h3>{tr('거절된 인증서')}</h3>
          {table(lists.rejected, true)}
          <h3>{tr('믿는 인증서')}</h3>
          {table(lists.trusted, false)}
        </>
      )}
    </div>
  );
}
