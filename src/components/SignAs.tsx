import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { teamIdsOf } from '../lib/occurrences';

/** 工位账号（多人共用的电脑）发讨论 / 留言时选一下是谁；同班组的人排前面 */
export function SignAs({ value, onChange, disabled }: { value: string; onChange: (name: string) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const me = useStore((s) => s.me);
  const profiles = useStore((s) => s.profiles);
  const memberships = useStore((s) => s.memberships);
  if (!me) return null;
  const myTeams = teamIdsOf(me, memberships);
  const same = (id: string) => {
    const p = profiles.find((x) => x.id === id);
    return !!p && teamIdsOf(p, memberships).some((tid) => myTeams.includes(tid));
  };
  const people = profiles
    .filter((p) => p.active && !p.is_station)
    .sort((a, b) => Number(same(b.id)) - Number(same(a.id)) || a.name.localeCompare(b.name));
  return (
    <select className={`select sign-as ${value ? '' : 'empty'}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label={t('discuss.signAs')} disabled={disabled}>
      <option value="">{t('discuss.signAsPlaceholder')}</option>
      {people.map((p) => (
        <option key={p.id} value={p.name}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
