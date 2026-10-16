#!/usr/bin/env node
/**
 * Provider selection (spec §三, §十三). One entry point so the scan layer never
 * has to know which transport it is talking to, and so the report can always
 * state honestly whether replies were *unreadable* or merely *absent*.
 */
import fs from "node:fs";

import type { CollectionProvider, ProviderCapabilities, Tweet } from "../types.ts";
import type { Config } from "../config.ts";
import type { DatabaseSync } from "node:sqlite";

import { Http } from "./http.ts";
import { SyndicationProvider } from "./syndication.ts";
import { ApiV2Provider } from "./api.ts";
import { SessionProvider } from "./session.ts";
import { ImportProvider } from "./import.ts";

export interface ProviderBundle {
  name: string;
  primary: CollectionProvider;
  /** Syndication is kept for the root post even when the primary transport is used. */
  root: CollectionProvider;
  capabilities: ProviderCapabilities;
  notes: string[];
  canEnumerateReplies: boolean;
}

function importReady(cfg: Config): boolean {
  return Boolean(cfg.fetch.importFile && fs.existsSync(cfg.fetch.importFile));
}

export function createProviders(db: DatabaseSync, cfg: Config): ProviderBundle {
  const http = new Http(db, cfg);
  const syndication = new SyndicationProvider(http, cfg);
  const api = new ApiV2Provider(http, cfg);
  const session = new SessionProvider(http, cfg);
  const notes: string[] = [];
  const wanted = cfg.fetch.provider;

  const build = (kind: Exclude<Config["fetch"]["provider"], "auto">): CollectionProvider | null => {
    switch (kind) {
      case "file":
        if (!cfg.fetch.importFile) {
          notes.push(`provider=file requested but fetch.importFile is empty`);
          return null;
        }
        return new ImportProvider(cfg.fetch.importFile);
      case "fixture":
        return new ImportProvider(cfg.fetch.fixtureFile || defaultFixture(cfg));
      case "api":
        if (!process.env[cfg.fetch.bearerTokenEnv]) {
          notes.push(`provider=api unavailable: ${cfg.fetch.bearerTokenEnv} is not set`);
          return null;
        }
        return api;
      case "session":
        if (!session.ready()) {
          notes.push(
            `provider=session unavailable: needs ${cfg.fetch.authTokenEnv}, ${cfg.fetch.ct0Env} and fetch.tweetDetailQueryId`,
          );
          return null;
        }
        return session;
      case "syndication":
        return syndication;
    }
  };

  const resolve = (): { provider: CollectionProvider | null; kind: string } => {
    if (wanted !== "auto") {
      const p = build(wanted);
      return { provider: p, kind: wanted };
    }
    // Auto: strongest available transport wins. Keyless syndication is the
    // fallback, and it can only read the root post.
    for (const kind of ["api", "session", "syndication"] as const) {
      const p = build(kind);
      if (p) return { provider: p, kind };
    }
    return { provider: syndication, kind: "syndication" };
  };

  let { provider, kind } = resolve();
  if (!provider) {
    notes.push(`falling back to syndication (root post only)`);
    provider = syndication;
    kind = "syndication";
  }
  if (provider instanceof ImportProvider) notes.push(...provider.warnings);

  const caps = provider.capabilities();
  const canEnumerateReplies = caps.replies;
  if (!canEnumerateReplies && kind !== "file" && kind !== "fixture") {
    notes.push(
      "no credential-backed transport is available, so replies cannot be enumerated: add an X API bearer token, a logged-in session, or an import file",
    );
  }
  notes.push(`root post source: ${kind === "syndication" ? "syndication" : caps.rootTweet ? kind : "syndication"}`);

  return {
    name: kind,
    primary: provider,
    root: caps.rootTweet ? provider : syndication,
    capabilities: caps,
    notes,
    canEnumerateReplies,
  };
}

function defaultFixture(cfg: Config): string {
  if (cfg.fetch.fixtureFile) return cfg.fetch.fixtureFile;
  // Packaged demo thread, resolved relative to this project.
  const here = new URL("../../fixtures/demo-thread.json", import.meta.url);
  return fs.existsSync(here) ? decodeURIComponent(here.pathname) : cfg.fetch.fixtureFile;
}

/** Root post, trying the primary transport and then syndication. */
export async function fetchRootTweet(bundle: ProviderBundle, id: string): Promise<Tweet | null> {
  try {
    const direct = await bundle.root.fetchTweet(id);
    if (direct) return direct;
  } catch {
    /* fall through to the backup transport */
  }
  if (bundle.root === bundle.primary) return null;
  return bundle.primary.fetchTweet(id).catch(() => null);
}
