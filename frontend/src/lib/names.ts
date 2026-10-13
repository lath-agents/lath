"use client";

import { useCallback, useSyncExternalStore } from "react";
import { hex, idFromString } from "@lath/sdk/browser";

/**
 * Names are not on-chain. `agent_id = sha256(name)` is one-way, so the chain can prove that a
 * name you already know matches an id, and can never hand you the name. The app therefore keeps a
 * local name book: you tell the app what your agents are called, it checks the claim by
 * re-hashing, and everyone else sees hex. A registry shared between browsers would let others see
 * the names too; this build has none.
 */
const KEY = "lath.names.v1";
/** The older key a name book may still sit under. Read once and copied to `KEY`, so a book stored
 *  there survives — the names are local, so losing it would leave the operator's own agents showing
 *  as hex with no way to recover the names. Frozen: a browser's stored book is found by this exact
 *  string. */
const LEGACY_KEY = "lattice.names.v1";

type NameBook = Record<string, string>;

const listeners = new Set<() => void>();
let cache: NameBook | null = null;

/** A stored book, or `{}` for anything that is not a plain object — `null`, an array, a number
 *  another script wrote under the key. Spreading one of those into a claim would lose it or throw. */
function parseBook(raw: string): NameBook {
  const v: unknown = JSON.parse(raw);
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  // Re-hash on read: localStorage is writable by any script on the origin, so a stored
  // entry is only a claim. One whose name does not hash to its id would label an agent with a
  // name it does not have, so it is dropped rather than shown.
  const book: NameBook = {};
  for (const [id, name] of Object.entries(v)) {
    if (typeof name === "string" && hex(idFromString(name)) === id) book[id] = name;
  }
  return book;
}

function read(): NameBook {
  if (cache) return cache;
  if (typeof window === "undefined") return (cache = {});
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return (cache = parseBook(raw));
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (!legacy) return (cache = {});
    cache = parseBook(legacy);
    window.localStorage.setItem(KEY, legacy);
  } catch {
    cache = {};
  }
  return cache;
}

function write(next: NameBook) {
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A private window with storage disabled still gets a working app, just no names.
  }
  listeners.forEach((l) => l());
}

/** The server renders no names at all. One frozen object, so the snapshot is referentially
 *  stable — returning a fresh `{}` per call makes React loop. */
const EMPTY: NameBook = Object.freeze({});

function serverSnapshot(): NameBook {
  return EMPTY;
}

/**
 * Another tab wrote the book. `storage` fires only in *other* tabs — exactly the case the cache
 * went stale in, since this tab's own writes refresh it — and a `null` key is `localStorage.clear()`.
 * Dropping the cache makes the next `read()` a fresh snapshot, which is also what tells
 * `useSyncExternalStore` something changed: the object is new only when the cache was dropped.
 */
function onStorage(e: StorageEvent) {
  if (e.key !== KEY && e.key !== null) return;
  cache = null;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useNameBook() {
  const book = useSyncExternalStore(subscribe, read, serverSnapshot);

  // A write re-reads storage before it merges. Two tabs can both be open with neither having
  // fired `storage` yet, and a merge into this tab's snapshot would write that snapshot back over
  // the other tab's claims: tab 1 claims *alpha*, tab 2 — opened earlier — claims *beta*, and
  // *alpha* would be gone.

  /** Records `name` for whatever id it hashes to. Returns the id it claimed. */
  const claim = useCallback((name: string) => {
    const id = hex(idFromString(name));
    cache = null;
    write({ ...read(), [id]: name });
    return id;
  }, []);

  const forget = useCallback((id: string) => {
    cache = null;
    const next = { ...read() };
    delete next[id];
    write(next);
  }, []);

  return { book, claim, forget, nameOf: (id: string) => book[id] };
}
