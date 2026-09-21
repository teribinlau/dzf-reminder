import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { useOccurrences, useSelected } from '../lib/useData';
import { hasSubmitted, missingSubmitters, resolveAssignees, teamName } from '../lib/occurrences';
import { beforeLabel, dateLabel, hm, relativeLabel, repeatLabel, whenLabel } from '../lib/format';
import { localYmd } from '../lib/recurrence';
import { linkTitle, parseLinks } from '../lib/links';
import { isMacDesktop, openExternal } from '../lib/tauri';
import type { Submission } from '../lib/types';
import { Avatar } from './Avatar';
import { IconCheck, IconDownload, IconEdit, IconExternal, IconFile, IconTrash, IconUpload, IconX } from './Icons';

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function DetailPanel() {
  const { t } = useTranslation();
  const now = new Date();
  const from = useMemo(() => new Date(now.getTime() - 30 * 86400000), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const to = useMemo(() => new Date(now.getTime() + 60 * 86400000), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const occs = useOccurrences(from, to, false, true);
  const o = useSelected(occs);
  const teams = useStore((s) => s.teams);
  const profiles = useStore((s) => s.profiles);
  const assignees = useStore((s) => s.assignees);
  const memberships = useStore((s) => s.memberships);
  const completions = useStore((s) => s.completions);
  const me = useStore((s) => s.me);
  const session = useStore((s) => s.session);
  const lang = useStore((s) => s.settings.lang);
  const requestComplete = useStore((s) => s.requestComplete);
  const uncomplete = useStore((s) => s.uncomplete);
  const snooze = useStore((s) => s.snooze);
  const openEdit = useStore((s) => s.openEdit);
  const deleteReminder = useStore((s) => s.deleteReminder);
  const uploadSubmission = useStore((s) => s.uploadSubmission);
  const deleteSubmission = useStore((s) => s.deleteSubmission);
  const uploading = useStore((s) => s.uploading);
  const repo = useStore((s) => s.repo);
  const pushToast = useStore((s) => s.pushToast);
  const select = useStore((s) => s.select);
  const mobileOpen = useStore((s) => s.mobileDetailOpen);

  const completeInput = useRef<HTMLInputElement>(null);
  const moreInput = useRef<HTMLInputElement>(null);
  const [zipping, setZipping] = useState(false);
  const [canZip, setCanZip] = useState(true);
  useEffect(() => {
    void isMacDesktop().then((mac) => setCanZip(!mac));
  }, []);

  if (!o) {
    return (
      <aside className={`detail ${mobileOpen ? 'open' : ''}`}>
        <div className="hint">{t('detail.selectHint')}</div>
      </aside>
    );
  }
  const r = o.reminder;
  const team = teams.find((x) => x.id === r.team_id);
  const color = team?.color ?? 'var(--ink)';
  const { people, teams: assignedTeams } = resolveAssignees(r, assignees, profiles, teams, memberships);
  const creator = profiles.find((p) => p.id === r.created_by);
  const canEdit = me && (me.id === r.created_by || me.role === 'admin');
  const rel = relativeLabel(o.at);
  const links = parseLinks(r.link).filter((l) => l.url);
  const history = completions
    .filter((c) => c.reminder_id === r.id)
    .sort((a, b) => new Date(b.occurrence_at).getTime() - new Date(a.occurrence_at).getTime())
    .slice(0, 6);
  // 重复提醒：补上最近几次「未完成」的记录
  const missed = r.rrule
    ? occs.filter((x) => x.reminder.id === r.id && x.at < now && !x.completion && x.key !== o.key).slice(-3)
    : [];
  const rows = [
    ...history.map((c) => ({ key: c.id, at: new Date(c.occurrence_at), ok: true, who: c.completed_by_name || profiles.find((p) => p.id === c.completed_by)?.name || '', time: hm(new Date(c.completed_at)) })),
    ...missed.map((x) => ({ key: x.key, at: x.at, ok: false, who: '', time: '' })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 6);
  const assigneeLabel = assignedTeams.length
    ? assignedTeams.map((tm) => t('detail.wholeTeam', { team: teamName(tm, lang) })).join(' · ')
    : t('detail.people', { n: people.length });

  // 回传文件
  const showSubmissions = r.require_upload || o.submissions.length > 0;
  const mine = session ? hasSubmitted(o, session.userId) : false;
  const missing = r.require_upload && r.completion_mode === 'each' ? missingSubmitters(o, people) : [];
  const subName = (s: Submission) => s.uploaded_by_name || profiles.find((p) => p.id === s.uploaded_by)?.name || '';
  const canDeleteSub = (s: Submission) => !!me && (s.uploaded_by === me.id || me.role === 'admin' || r.created_by === me.id);

  const pickFiles = (input: HTMLInputElement | null): File[] => {
    const files = Array.from(input?.files ?? []);
    if (input) input.value = '';
    return files;
  };
  const onCompleteFiles = () => {
    const files = pickFiles(completeInput.current);
    if (files.length) requestComplete(o, files);
  };
  const onMoreFiles = () => {
    const files = pickFiles(moreInput.current);
    if (!files.length) return;
    // 工位模式要先选是谁，走完成流程（已完成的话只是多传一份）
    if (me?.is_station) requestComplete(o, files);
    else void uploadSubmission(o, files);
  };
  const download = async (s: Submission) => {
    try {
      await openExternal(await repo.submissionUrl(s));
    } catch (e) {
      pushToast({ title: t('errors.downloadFailed'), body: (e as Error).message, kind: 'error' });
    }
  };
  const downloadAll = async () => {
    setZipping(true);
    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const used = new Set<string>();
      for (const s of o.submissions) {
        const res = await fetch(await repo.submissionUrl(s));
        if (!res.ok) throw new Error(`${res.status} ${s.file_name}`);
        const who = subName(s).replace(/[\\/:*?"<>|]/g, '_');
        let name = who ? `${who}_${s.file_name}` : s.file_name;
        let i = 2;
        while (used.has(name)) name = `${i++}_${name}`;
        used.add(name);
        zip.file(name, await res.blob());
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${r.title.slice(0, 40).replace(/[\\/:*?"<>|]/g, '_')}_${localYmd(o.at)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      pushToast({ title: t('errors.downloadFailed'), body: (e as Error).message, kind: 'error' });
    } finally {
      setZipping(false);
    }
  };

  return (
    <aside className={`detail ${mobileOpen ? 'open' : ''}`}>
      <div className="head">
        <span className="kicker">{t('detail.title')}</span>
        {canEdit && (
          <>
            <button className="icon-btn" aria-label={t('actions.edit')} onClick={() => openEdit(r.id)}>
              <IconEdit size={16} />
            </button>
            <button
              className="icon-btn"
              aria-label={t('actions.delete')}
              onClick={() => {
                if (window.confirm(t('actions.confirmDelete'))) void deleteReminder(r.id);
              }}
            >
              <IconTrash size={16} />
            </button>
          </>
        )}
        <button className="icon-btn" aria-label={t('actions.close')} onClick={() => select(null)}>
          <IconX size={16} />
        </button>
      </div>

      <div className="field" style={{ gap: 8 }}>
        <span className="label" style={{ color }}>
          {[teamName(team, lang), r.priority === 'high' ? t('priority.highLabel') : '', t(`visibility.${r.visibility}`), r.require_upload ? t('submit.badge') : ''].filter(Boolean).join(' · ')}
        </span>
        <h2>{r.title}</h2>
      </div>

      <div className="time-block">
        <span className="big">{hm(o.at)}</span>
        <div className="lines">
          {o.completion ? (
            <span className="ok">{t('actions.completed')} · {o.completion.completed_by_name || profiles.find((p) => p.id === o.completion!.completed_by)?.name}</span>
          ) : (
            <span className={rel.hot ? 'hot' : ''}>
              {whenLabel(o.at, false)} · {rel.text}
            </span>
          )}
          <span>
            {repeatLabel(r)} · {beforeLabel(r.remind_before_min)}
          </span>
          {r.overdue_repeat_min > 0 && <span>{t('form.overdueRepeat', { n: r.overdue_repeat_min })}</span>}
        </div>
      </div>

      <div className="field" style={{ gap: 8 }}>
        <span className="kicker">{t('detail.assignees')}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="avatars" style={{ paddingLeft: 6 }}>
            {people.slice(0, 6).map((p) => (
              <Avatar key={p.id} p={p} />
            ))}
          </span>
          <span className="hint-text">
            {assigneeLabel} · {t(`completionMode.${r.completion_mode}`)}
          </span>
        </div>
      </div>

      {r.source === 'notion' && (
        <div className="sync-note">
          <span className="sync-badge">Notion</span>
          <span>{t('sync.notionHint')}</span>
        </div>
      )}

      {r.notes && (
        <div className="field" style={{ gap: 6 }}>
          <span className="kicker">{t('detail.notes')}</span>
          <p style={{ whiteSpace: 'pre-line' }}>{r.notes}</p>
        </div>
      )}

      {links.length > 0 && (
        <div className="field" style={{ gap: 6 }}>
          <span className="kicker">{t('detail.links')}</span>
          <div className="links">
            {links.map((l, i) => (
              <a
                key={i}
                className="link-row"
                href={l.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  void openExternal(l.url);
                }}
              >
                <IconExternal size={13} />
                <span className="link-title">{linkTitle(l)}</span>
                {l.label && <span className="link-host">{linkTitle({ label: '', url: l.url })}</span>}
              </a>
            ))}
          </div>
        </div>
      )}

      {showSubmissions && (
        <div className="field" style={{ gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="kicker grow">
              {t('detail.submissions')}
              {o.submissions.length > 0 ? ` · ${o.submissions.length}` : ''}
            </span>
            {o.submissions.length > 0 && canZip && (
              <button className="mini-btn" onClick={() => void downloadAll()} disabled={zipping}>
                <IconDownload size={12} />
                {zipping ? t('detail.zipping') : t('detail.downloadAll')}
              </button>
            )}
            {(o.completion || mine || !r.require_upload) && (
              <button className="mini-btn" onClick={() => moreInput.current?.click()} disabled={uploading}>
                <IconUpload size={12} />
                {t('detail.uploadMore')}
              </button>
            )}
          </div>
          {o.submissions.length ? (
            <div className="sub-list">
              {o.submissions.map((s) => (
                <div key={s.id} className="sub-row">
                  <button className="sub-file" onClick={() => void download(s)} title={s.file_name}>
                    <IconFile size={14} />
                    <span className="sub-name">{s.file_name}</span>
                  </button>
                  <span className="sub-meta">
                    {subName(s)} · {hm(new Date(s.created_at))} · {fmtSize(s.size)}
                  </span>
                  {canDeleteSub(s) && (
                    <button
                      className="icon-btn sm"
                      aria-label={t('actions.delete')}
                      onClick={() => {
                        if (window.confirm(t('submit.confirmDelete', { name: s.file_name }))) void deleteSubmission(s);
                      }}
                    >
                      <IconX size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <span className="hint-text">{t('detail.noSubmissions')}</span>
          )}
          {r.require_upload && r.completion_mode === 'each' && people.length > 0 && (
            <span className={`hint-text ${missing.length ? 'bad' : ''}`}>
              {missing.length ? t('detail.missing', { names: missing.map((p) => p.name).join('、') }) : t('detail.allSubmitted')}
            </span>
          )}
          <input ref={moreInput} type="file" multiple hidden onChange={onMoreFiles} />
        </div>
      )}

      <div className="field" style={{ gap: 6 }}>
        <span className="kicker">{t('detail.history')}</span>
        {rows.length ? (
          <div className="history">
            {rows.map((row) => (
              <div key={row.key} className="row">
                <span className="dot" style={{ width: 8, height: 8, background: row.ok ? 'var(--green)' : 'var(--red)' }} />
                <span className="d">{localYmd(row.at) === localYmd(now) ? t('time.today') : dateLabel(localYmd(row.at))}</span>
                <span className={`who ${row.ok ? '' : 'bad'}`}>{row.ok ? `${row.time} · ${row.who}` : t('detail.notDone')}</span>
              </div>
            ))}
          </div>
        ) : (
          <span className="hint-text">{t('detail.noHistory')}</span>
        )}
      </div>

      <div className="actions">
        {o.completion ? (
          <button className="btn outline lg block" onClick={() => void uncomplete(o)}>
            {t('actions.undo')}
          </button>
        ) : (
          <>
            {r.require_upload && !mine ? (
              <>
                <button className="btn primary lg block" onClick={() => completeInput.current?.click()} disabled={uploading}>
                  <IconUpload size={16} />
                  {uploading ? t('actions.uploading') : t('actions.uploadComplete')}
                </button>
                <span className="hint-text" style={{ textAlign: 'center' }}>
                  {t('submit.needUploadHint')}
                </span>
                <input ref={completeInput} type="file" multiple hidden onChange={onCompleteFiles} />
              </>
            ) : (
              <button className="btn primary lg block" onClick={() => requestComplete(o)}>
                <IconCheck size={16} />
                {t('actions.complete')}
              </button>
            )}
            <div className="row2">
              <button className="btn outline" onClick={() => void snooze(o, 10)}>
                {t('actions.snooze10')}
              </button>
              <button className="btn ghost" onClick={() => void snooze(o, 24 * 60)}>
                {t('actions.skipToday')}
              </button>
            </div>
          </>
        )}
        <span className="foot">
          {t('detail.createdBy', { name: creator?.name ?? '' })} · {dateLabel(localYmd(new Date(r.created_at)))}
        </span>
      </div>
    </aside>
  );
}
