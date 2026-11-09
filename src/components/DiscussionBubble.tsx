import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { useDiscussions } from '../lib/useDiscussions';
import { ts } from '../lib/discussions';
import type { Discussion, Profile } from '../lib/types';
import { Avatar } from './Avatar';
import { IconX } from './Icons';

/** 气泡停留多久（鼠标停在上面时不走） */
export const BUBBLE_MS = 8000;
/** 开始盯之前多久的动静也算（服务器时间和这台电脑的时间差一点、刚好在加载那一刻写进来的） */
const SLACK_MS = 5 * 60000;

interface Bubble {
  key: string;
  discussionId: string;
  who: Pick<Profile, 'id' | 'name'>;
  /** 「在『xx』留言」/「发起了讨论」 */
  action: string;
  /** 留言内容 / 新讨论的标题 */
  text: string;
  /** 这个气泡还在的时候又来了几条 */
  more: number;
}

type Place =
  | { mode: 'side'; left: number; top: number }
  | { mode: 'up'; bottom: number; left: number; width: number; arrow: number | null }
  | { mode: 'down'; top: number; left: number; width: number };

const shortTitle = (s: string) => (s.length > 24 ? s.slice(0, 23) + '…' : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 左栏（手机上是底栏）「讨论」那个按钮在哪：桌面在右边弹出，手机在底栏上面弹出；手机上讨论盖满屏幕时放到顶上 */
function measure(covered: boolean): Place {
  const vw = window.innerWidth;
  const rail = document.querySelector<HTMLElement>('.rail [data-bubble-anchor]')?.getBoundingClientRect();
  if (rail && rail.width > 0) return { mode: 'side', left: Math.round(rail.right + 12), top: Math.round(rail.top + rail.height / 2) };
  const width = Math.min(420, vw - 24);
  const left = Math.round((vw - width) / 2);
  const tab = document.querySelector<HTMLElement>('.tabbar [data-bubble-anchor]')?.getBoundingClientRect();
  if (covered || !tab || tab.width === 0) return { mode: 'down', top: 12, left, width };
  const ax = Math.round(tab.left + tab.width / 2 - left);
  return { mode: 'up', bottom: Math.round(window.innerHeight - tab.top + 10), left, width, arrow: Math.min(width - 18, Math.max(18, ax)) };
}

/**
 * 讨论有新动静（别人发起了讨论 / 别人留言）时，从左栏「讨论」图标旁边弹出一个小气泡：
 * 谁、在哪个讨论、说了什么；8 秒后自己收起（鼠标停在上面不收），点一下打开那个讨论。红色数字照旧。
 * 只提示打开应用之后来的（打开时已经有的未读看红色数字）；正看着的那个讨论来的留言不提示；「静音 1 小时」时也不提示。
 */
export function DiscussionBubble() {
  const { t } = useTranslation();
  const me = useStore((s) => s.me);
  const loaded = useStore((s) => s.loaded);
  const fromCache = useStore((s) => s.fromCache);
  const comments = useStore((s) => s.comments);
  const profiles = useStore((s) => s.profiles);
  const view = useStore((s) => s.view);
  const discussionId = useStore((s) => s.discussionId);
  const openDiscussion = useStore((s) => s.openDiscussion);
  const { open, closed } = useDiscussions();
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const seen = useRef<{ user: string; comments: Set<string>; discussions: Set<string>; since: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const hover = useRef(false);

  // 盯着讨论和留言：第一次（从服务器）加载完记下已有的，之后多出来的、别人写的才算新动静
  useEffect(() => {
    if (!me || !loaded || fromCache) return;
    const visible = [...open, ...closed];
    const s = seen.current;
    if (!s || s.user !== me.id) {
      let since = 0;
      for (const c of comments) since = Math.max(since, ts(c.created_at));
      for (const d of visible) since = Math.max(since, ts(d.created_at));
      seen.current = { user: me.id, comments: new Set(comments.map((c) => c.id)), discussions: new Set(visible.map((d) => d.id)), since };
      return;
    }
    const byId = new Map(visible.map((d) => [d.id, d]));
    const st = useStore.getState();
    const muted = !!st.mutedUntil && st.mutedUntil.getTime() > Date.now();
    // 正看着的那个讨论（窗口在前台）：留言自己就看到了，不用再提示
    const watching = (d: Discussion) =>
      st.view === 'discussions' && st.discussionId === d.id && document.visibilityState === 'visible' && document.hasFocus();
    const nameOf = (id: string, name: string): Pick<Profile, 'id' | 'name'> => {
      if (name) return profiles.find((p) => p.name === name) ?? { id: `name:${name}`, name };
      return profiles.find((p) => p.id === id) ?? { id, name: '?' };
    };
    const events: (Omit<Bubble, 'more'> & { at: number })[] = [];
    for (const d of visible) {
      if (s.discussions.has(d.id)) continue;
      s.discussions.add(d.id);
      if (d.created_by === me.id || d.closed_at || ts(d.created_at) <= s.since - SLACK_MS || muted || watching(d)) continue;
      events.push({ key: 'd:' + d.id, discussionId: d.id, who: nameOf(d.created_by, d.created_by_name), action: t('discuss.bubbleStarted'), text: oneLine(d.title), at: ts(d.created_at) });
    }
    for (const c of comments) {
      if (s.comments.has(c.id)) continue;
      s.comments.add(c.id);
      const d = byId.get(c.discussion_id);
      if (!d || c.author_id === me.id || ts(c.created_at) <= s.since - SLACK_MS || muted || watching(d)) continue;
      events.push({
        key: 'c:' + c.id,
        discussionId: d.id,
        who: nameOf(c.author_id, c.author_name),
        action: t('discuss.bubbleCommented', { title: shortTitle(oneLine(d.title)) }),
        text: oneLine(c.body) || t('discuss.bubbleAttachment'),
        at: ts(c.created_at),
      });
    }
    if (!events.length) return;
    events.sort((a, b) => a.at - b.at);
    const { at: _at, ...latest } = events[events.length - 1];
    setBubble((prev) => ({ ...latest, more: (prev ? prev.more + 1 : 0) + events.length - 1 }));
  }, [me, loaded, fromCache, comments, open, closed, profiles, t]);

  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    hover.current = false;
    setBubble(null);
  }, []);

  const arm = useCallback(
    (ms: number) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (!hover.current) close();
      }, ms);
    },
    [close],
  );

  // 每来一条新的重新计时
  useEffect(() => {
    if (!bubble) return;
    if (!hover.current) arm(BUBBLE_MS);
    return () => window.clearTimeout(timer.current);
  }, [bubble?.key, arm]); // eslint-disable-line react-hooks/exhaustive-deps

  // 别的地方把这个讨论打开了（点了列表 / 红色数字）→ 气泡没用了
  useEffect(() => {
    if (bubble && view === 'discussions' && discussionId === bubble.discussionId) close();
  }, [bubble, view, discussionId, close]);

  // 位置跟着「讨论」按钮走（窗口大小变了、手机上打开 / 关上讨论）
  const covered = view === 'discussions' && !!discussionId;
  useLayoutEffect(() => {
    if (!bubble) return;
    const update = () => setPlace(measure(covered));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [bubble, covered]);

  if (!bubble || !place) return null;
  const style: React.CSSProperties =
    place.mode === 'side'
      ? { left: place.left, top: place.top }
      : place.mode === 'up'
        ? { left: place.left, width: place.width, bottom: place.bottom, ...(place.arrow !== null ? ({ '--ax': `${place.arrow}px` } as React.CSSProperties) : {}) }
        : { left: place.left, width: place.width, top: place.top };
  return (
    <div
      className={`dbubble ${place.mode}`}
      style={style}
      role="status"
      aria-live="polite"
      onMouseEnter={() => {
        hover.current = true;
        window.clearTimeout(timer.current);
      }}
      onMouseLeave={() => {
        hover.current = false;
        arm(BUBBLE_MS / 2);
      }}
    >
      <button
        className="db-main"
        aria-label={t('discuss.bubbleOpen')}
        onClick={() => {
          const id = bubble.discussionId;
          close();
          openDiscussion(id);
        }}
      >
        <Avatar p={bubble.who} size="sm" />
        <span className="db-txt">
          <span className="db-head">
            <b>{bubble.who.name}</b> {bubble.action}
          </span>
          <span className="db-body">{bubble.text}</span>
          {bubble.more > 0 && <span className="db-more">{t('discuss.bubbleMore', { count: bubble.more })}</span>}
        </span>
      </button>
      <button className="db-x" aria-label={t('discuss.bubbleClose')} title={t('discuss.bubbleClose')} onClick={close}>
        <IconX size={14} />
      </button>
    </div>
  );
}
