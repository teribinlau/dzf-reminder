import type { Profile } from '../lib/types';
import { avatarColor, initials } from '../lib/occurrences';

export function Avatar({ p, size = '' }: { p: Pick<Profile, 'id' | 'name'>; size?: '' | 'sm' | 'lg' }) {
  return (
    <span className={`avatar ${size}`} style={{ background: avatarColor(p.id) }} title={p.name}>
      {initials(p.name)}
    </span>
  );
}

export function AvatarStack({ people, max = 3, onWhite = false }: { people: Pick<Profile, 'id' | 'name'>[]; max?: number; onWhite?: boolean }) {
  if (!people.length) return null;
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className={`avatars ${onWhite ? 'on-white' : ''}`}>
      {shown.map((p) => (
        <Avatar key={p.id} p={p} />
      ))}
      {rest > 0 && <span className="avatar more">+{rest}</span>}
    </span>
  );
}
