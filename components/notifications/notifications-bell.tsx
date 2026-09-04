'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Bell } from 'lucide-react'
import { PopoverMenu } from '@/components/ui/popover-menu'
import { getNotifications, markNotificationsRead, type NotificationView } from '@/app/(app)/notifications/actions'
import { formatTimestamp } from '@/lib/relative-time'

export function NotificationsBell({ initialUnreadCount }: { initialUnreadCount: number }) {
  const [items, setItems] = useState<NotificationView[] | null>(null)
  const [unread, setUnread] = useState(initialUnreadCount)
  const [loading, setLoading] = useState(false)

  async function handleOpen(toggle: () => void) {
    toggle()
    if (items !== null) return
    setLoading(true)
    try {
      setItems(await getNotifications())
    } finally {
      setLoading(false)
    }
  }

  function handleItemClick(item: NotificationView) {
    if (item.isRead) return
    setItems((prev) => prev?.map((i) => (i.id === item.id ? { ...i, isRead: true } : i)) ?? prev)
    setUnread((n) => Math.max(0, n - 1))
    void markNotificationsRead([item.id])
  }

  return (
    <PopoverMenu
      align="end"
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={() => void handleOpen(toggle)}
          title="Notifications"
          className="relative flex h-7 w-7 items-center justify-center rounded-md hover:bg-black/[.06] dark:hover:bg-white/[.08]"
        >
          <Bell size={14} />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-medium leading-none text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-96 w-80 overflow-y-auto">
          <div className="px-2 py-1.5 text-xs font-medium text-black/40 dark:text-white/40">Notifications</div>
          {loading && <p className="px-2 py-3 text-xs text-black/40 dark:text-white/40">Loading…</p>}
          {!loading && items?.length === 0 && (
            <p className="px-2 py-3 text-xs text-black/40 dark:text-white/40">No notifications yet.</p>
          )}
          {!loading &&
            items?.map((item) => <NotificationRow key={item.id} item={item} onClick={() => { handleItemClick(item); close() }} />)}
        </div>
      )}
    </PopoverMenu>
  )
}

function NotificationRow({ item, onClick }: { item: NotificationView; onClick: () => void }) {
  const content = (
    <div className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-black/[.04] dark:hover:bg-white/[.06]">
      {!item.isRead && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />}
      <div className={`min-w-0 flex-1 ${item.isRead ? 'pl-3.5' : ''}`}>
        <p className="truncate">
          <span className="font-medium">{item.actorName || 'Someone'}</span>{' '}
          <span className="text-black/60 dark:text-white/60">{humanizeAction(item.action)}</span>
        </p>
        <p className="text-xs text-black/30 dark:text-white/30">{formatTimestamp(item.createdAt)}</p>
      </div>
    </div>
  )

  if (!item.href) {
    return (
      <button type="button" onClick={onClick} className="block w-full text-left">
        {content}
      </button>
    )
  }

  return (
    <Link href={item.href} onClick={onClick} className="block">
      {content}
    </Link>
  )
}

function humanizeAction(action: string | null): string {
  switch (action) {
    case 'created':
      return 'created this'
    case 'renamed':
      return 'renamed this'
    case 'status_changed':
      return 'changed the status'
    case 'assignee_changed':
      return 'changed the assignee'
    case 'project_changed':
      return 'moved this to a different project'
    default:
      return action || 'updated this'
  }
}
