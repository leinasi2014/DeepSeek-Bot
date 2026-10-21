// The sidebar shows Main Bot first, then two sections the user can fold: the group chats and
// the Bots (agents belong with the Bots). This module is the part that touches no DOM, so the
// rules for reading, writing and grouping can be tested without a browser.
import { STORAGE } from './storage.js'

// true means expanded. Both sections start expanded, and anything unreadable means the same:
// a broken preference must never hide the user's groups.
export const DEFAULT_SECTIONS = Object.freeze({ rooms: true, bots: true })

const one = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

export function readSections(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE.ui)
    if (typeof raw !== 'string' || raw === '') return { ...DEFAULT_SECTIONS }
    const value = JSON.parse(raw)
    if (value === null || typeof value !== 'object') return { ...DEFAULT_SECTIONS }
    const sections = value.sections
    if (sections === null || typeof sections !== 'object') return { ...DEFAULT_SECTIONS }
    return { rooms: one(sections.rooms, true), bots: one(sections.bots, true) }
  } catch {
    return { ...DEFAULT_SECTIONS }
  }
}

export function writeSections(next, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE.ui)
    let held = {}
    try {
      const value = typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : {}
      if (value !== null && typeof value === 'object') held = value
    } catch {
      held = {}
    }
    const sections = { ...readSections(storage), ...next }
    storage?.setItem(STORAGE.ui, JSON.stringify({ ...held, sections }))
  } catch {
    // A preference that cannot be saved is not worth taking the sidebar down for.
  }
}

// Order arrives sorted (pinned first, then most recent) and keeps that order inside a
// section. The Main Bot is not in it: it is rendered above the sections.
export function groupEntries(order) {
  const rooms = []
  const bots = []
  for (const entry of order) {
    if (entry.kind === 'room') rooms.push(entry)
    else bots.push(entry)
  }
  return { rooms, bots }
}

// What a folded section says inside it: how many rows it holds, and the three things the user
// may need to act on. Everything is counted from the rows the section actually shows, so a
// hidden Bot is not counted at all. An approval that names a room belongs to the group chats
// and is never counted again under Bots.
export function sectionCounts({ rooms, bots, unread, asks, approvals = [] }) {
  const counts = (items) => {
    const ids = new Set(items.map(item => item.id))
    return {
      rows: items.length,
      unread: items.filter(item => unread.has(item.id)).length,
      asks: items.filter(item => asks.has(item.id)).length,
      approvals: approvals.filter(entry => entry.roomId !== undefined && ids.has(entry.roomId)).length,
    }
  }
  const botCounts = counts(bots)
  botCounts.approvals = approvals.filter(entry => entry.roomId === undefined && bots.some(item => item.id === entry.botId)).length
  return { rooms: counts(rooms), bots: botCounts }
}
