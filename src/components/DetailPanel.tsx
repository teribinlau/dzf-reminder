import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { useOccurrences, useSelected } from '../lib/useData';
import { resolveAssignees, teamName } from '../lib/occurrences';
import { beforeLabel, dateLabel, hm, relativeLabel, repeatLabel, whenLabel } from '../lib/format';
import { localYmd } from '../lib/recurrence';
import { Avatar } from './Avatar';
import { IconCheck, IconEdit, IconLink, IconTrash, IconX } from './Icons';

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
  const completions = useStore((s) => s.completions);
  const me = useStore((s) => s.me);
  const lang = useStore((s) => s.settings.lang);
  const requestComplete = useStore((s) => s.requestComplete);
  const uncomplete = useStore((s) => s.uncomplete);
  const snooze = useStore((s) => s.snooze);
  const openEdit = useStore((s) => s.openEdit);
  const deleteReminder = useStore((s) => s.deleteReminder);
  const select = useStore((s) => s.select);
  const mobileOpen = useStore((s) => s.mobileDetailOpen);

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
  const { people, teams: assignedTeams } = resolveAssignees(r, assignees, profiles, teams);
  const creator = profiles.find((p) => p.id === r.created_by);
  const canEdit = me && (me.id === r.created_by || me.role === 'admin');
  const rel = relativeLabel(o.at);
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
          {[teamName(team, lang), r.priority === 'high' ? t('priority.highLabel') : '', t(`visibility.${r.visibility}`)].filter(Boolean).join(' · ')}
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

      {(r.notes || r.link) && (
        <div className="field" style={{ gap: 6 }}>
          <span className="kicker">{t('detail.notes')}</span>
          {r.notes && <p>{r.notes}</p>}
          {r.link && (
            <a className="link" href={r.link} target="_blank" rel="noreferrer">
              <IconLink size={12} />
              <span style={{ wordBreak: 'break-all' }}>{r.link.replace(/^https?:\/\//, '')}</span>
            </a>
          )}
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
            <button className="btn primary lg block" onClick={() => requestComplete(o)}>
              <IconCheck size={16} />
              {t('actions.complete')}
            </button>
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
