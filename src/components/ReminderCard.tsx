import { useTranslation } from 'react-i18next';
import type { Occurrence } from '../lib/types';
import { useStore } from '../lib/store';
import { resolveAssignees, teamName } from '../lib/occurrences';
import { beforeLabel, hm, relativeLabel, repeatLabel, whenLabel } from '../lib/format';
import { AvatarStack } from './Avatar';
import { IconCheck, IconLink, IconRepeat, IconUpload } from './Icons';
import { linkTitle, parseLinks } from '../lib/links';

const PRIORITY_COLOR: Record<string, string> = { high: 'var(--red)', medium: 'var(--amber)', low: 'var(--hair-2)' };

interface Props {
  o: Occurrence;
  variant?: 'full' | 'compact' | 'row';
  showDate?: boolean;
}

export function ReminderCard({ o, variant = 'full', showDate = false }: Props) {
  const { t } = useTranslation();
  const teams = useStore((s) => s.teams);
  const profiles = useStore((s) => s.profiles);
  const assignees = useStore((s) => s.assignees);
  const memberships = useStore((s) => s.memberships);
  const lang = useStore((s) => s.settings.lang);
  const selected = useStore((s) => s.selectedKey === o.key);
  const select = useStore((s) => s.select);
  const requestComplete = useStore((s) => s.requestComplete);
  const uncomplete = useStore((s) => s.uncomplete);

  const team = teams.find((x) => x.id === o.reminder.team_id);
  const color = team?.color ?? 'var(--hair-2)';
  const done = !!o.completion;
  const { people } = resolveAssignees(o.reminder, assignees, profiles, teams, memberships);
  const rel = relativeLabel(o.at);
  const cls = ['card', variant === 'full' ? '' : variant, selected ? 'selected' : '', done ? 'done' : '', o.isOverdue ? 'overdue' : ''].join(' ');
  const doneBy = o.completion ? (o.completion.completed_by_name || profiles.find((p) => p.id === o.completion!.completed_by)?.name || '') : '';

  const timeCol = (
    <div className="time-col" style={{ borderRightColor: done ? 'var(--hair-2)' : o.isOverdue ? 'var(--red)' : color }}>
      <span className="time">{hm(o.at)}</span>
      {done ? (
        <span className="time-sub">{t('detail.byName', { name: doneBy })}</span>
      ) : showDate ? (
        <span className={`time-sub ${o.isOverdue ? 'hot' : ''}`}>{o.isOverdue ? rel.text : whenLabel(o.at, false)}</span>
      ) : (
        <span className={`time-sub ${rel.hot ? 'hot' : ''}`}>{o.isOverdue || rel.hot ? rel.text : beforeLabel(o.reminder.remind_before_min)}</span>
      )}
    </div>
  );

  const label = [
    teamName(team, lang),
    o.reminder.priority === 'high' ? t('priority.highLabel') : '',
    o.reminder.rrule ? repeatLabel(o.reminder) : '',
    o.reminder.source === 'notion' ? 'Notion' : '',
    o.reminder.require_upload ? t('submit.badge') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const links = parseLinks(o.reminder.link).filter((l) => l.url);
  const submitted = o.submissions.length;

  if (variant === 'row') {
    return (
      <div className={cls} onClick={() => select(o.key)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && select(o.key)}>
        <button
          className="check"
          aria-label={done ? t('actions.undo') : t('actions.complete')}
          onClick={(e) => {
            e.stopPropagation();
            done ? void uncomplete(o) : requestComplete(o);
          }}
        >
          <span className={`check-sq ${done ? 'done' : o.isOverdue ? 'red' : ''}`}>{done && <IconCheck size={12} />}</span>
        </button>
        {timeCol}
        <div className="body">
          <span className="label" style={{ color: done ? 'var(--faint)' : color }}>{label}</span>
          <span className="title">{o.reminder.title}</span>
        </div>
        <div className="side">
          <AvatarStack people={people} onWhite={selected} />
          <span className="pri-dot" style={{ background: done ? 'var(--hair-2)' : PRIORITY_COLOR[o.reminder.priority] }} />
        </div>
      </div>
    );
  }

  if (variant === 'compact' || done) {
    return (
      <div className={`${cls} compact`} onClick={() => select(o.key)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && select(o.key)}>
        {timeCol}
        <div className="body" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {done && <IconCheck size={14} style={{ color: 'var(--green)', flexShrink: 0 }} />}
          {!done && team && (
            <span className="label" style={{ color, flexShrink: 0 }}>
              {teamName(team, lang)}
            </span>
          )}
          <span className="title">{o.reminder.title}</span>
        </div>
        <div className="side">
          <AvatarStack people={people} max={2} onWhite={selected} />
        </div>
      </div>
    );
  }

  return (
    <div className={cls} onClick={() => select(o.key)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && select(o.key)}>
      {timeCol}
      <div className="body">
        <span className="label" style={{ color }}>
          {label}
        </span>
        <span className="title">{o.reminder.title}</span>
        {(o.reminder.notes || links.length > 0 || o.reminder.rrule || o.reminder.require_upload) && (
          <span className="meta">
            {o.reminder.require_upload && (
              <span className="meta-pill">
                <IconUpload size={11} />
                {submitted > 0 ? t('submit.count', { n: submitted }) : t('submit.badge')}
              </span>
            )}
            {links.length > 0 && <IconLink size={12} />}
            {o.reminder.rrule && !o.reminder.notes && <IconRepeat size={12} />}
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {(o.reminder.notes || (o.reminder.rrule ? repeatLabel(o.reminder) : links.length ? links.map(linkTitle).join(' · ') : '')).split('\n')[0]}
            </span>
          </span>
        )}
      </div>
      <div className="side">
        <AvatarStack people={people} onWhite={selected} />
      </div>
    </div>
  );
}
