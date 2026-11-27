import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { TelnyxTranscriber, type Transcriber } from "../src/adapters/telnyx-transcribe.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { cleanHeard, clipType, withPronunciation, WORD_CLIP_MAX_BYTES } from "../src/domain/word-clips.js";
import { createRequestHandler } from "../src/http/app.js";
import type { Clock } from "../src/ports.js";

// Synthetic containers: the right magic bytes, then padding. Never real speech.
const webm = (size = 2_000) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(size - 4, 7)]);
const mp4 = (size = 2_000) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A ", "latin1"), Buffer.alloc(size - 12, 3)]);

describe("Say it clip helpers (walk 11-26, SET-05)", () => {
  it("takes what Chrome, iPhone Safari and Firefox record, and nothing else", () => {
    expect(clipType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(clipType("audio/mp4")).toBe("audio/mp4");
    expect(clipType("audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(clipType("text/html")).toBeNull();
    expect(clipType(undefined)).toBeNull();
  });

  it("tidies what was heard into one 'sounds like' line", () => {
    expect(cleanHeard(" My ACK uh. ")).toBe("My ACK uh");
    expect(cleanHeard("“Myakka!”")).toBe("Myakka");
    expect(cleanHeard("a: b\nc")).toBe("a b c");
    expect(cleanHeard("...")).toBeNull();
    // What speech-to-text sends back for one said phrase: never a stray full stop or quote in "Sounds like".
    for (const raw of ["Kiss me.", "\"Kiss me.\"", " \"Kiss me\". ", "“Kiss me.”", "'Kiss me!'", "(Kiss me…)", "Kiss me?\n", "«Kiss me»"]) expect(cleanHeard(raw)).toBe("Kiss me");
    expect(cleanHeard("Kiss me, Kate.")).toBe("Kiss me, Kate");
    expect(cleanHeard(null)).toBeNull();
  });

  it("sets one word's 'sounds like', matched without case, and keeps a word still waiting for it", () => {
    const list = [{ term: "Myakka", spokenAs: "old" }, { term: "Venice", spokenAs: "VEN-iss" }];
    expect(withPronunciation(list, "myakka", "my-AK-uh")).toEqual([{ term: "Myakka", spokenAs: "my-AK-uh" }, list[1]]);
    expect(withPronunciation(list, "Osprey", "OSS-pray")).toHaveLength(3);
  });
});

describe("TelnyxTranscriber", () => {
  it("posts the clip and the configured model to Telnyx speech-to-text with the API key", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ text: "my AK uh" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const heard = await new TelnyxTranscriber("synthetic-key", "synthetic/model", fake).transcribe(mp4(), "audio/mp4");
    expect(heard).toBe("my AK uh");
    expect(seen[0]!.url).toBe("https://api.telnyx.com/v2/ai/audio/transcriptions");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer synthetic-key");
    const form = seen[0]!.init.body as FormData;
    expect(form.get("model")).toBe("synthetic/model");
    expect((form.get("file") as File).name).toBe("word.mp4");
  });

  it("throws on a provider error, so the caller keeps the clip and leaves the field alone", async () => {
    const fake = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await expect(new TelnyxTranscriber("k", "m", fake).transcribe(webm(), "audio/webm")).rejects.toThrow(/500/);
  });
});

describe("Say it endpoints", () => {
  let server: Server;
  let store: InMemoryStore;
  let baseUrl: string;
  let webDir: string;
  let transcriber: Transcriber & { calls: number; answer: () => Promise<string | null> };
  const clock: Clock = { now: () => new Date("2026-11-26T15:00:00.000Z") };

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    webDir = await mkdtemp(join(tmpdir(), "afo-sayit-"));
    await mkdir(join(webDir, "assets"));
    await writeFile(join(webDir, "index.html"), '<!doctype html><div id="root"></div>');
    transcriber = { calls: 0, answer: async () => "my AK uh.", async transcribe() { this.calls += 1; return this.answer(); } };
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", PUBLIC_BASE_URL: "http://127.0.0.1:8787" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: () => undefined, ownerWeb: { dir: webDir }, transcriber }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(webDir, { recursive: true, force: true });
  });

  async function signUp(name = "Synthetic Air") {
    const email = `owner-${Math.random().toString(36).slice(2, 8)}@synthetic.example`;
    const response = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: name, email, password: "long-password-for-tests", phone: "(941) 555-0142", trade: "hvac" }) });
    expect(response.status).toBe(303);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const tenantId = (await store.getOwnerAccountByEmail(email))!.tenantId;
    const settings = async () => (await fetch(`${baseUrl}/api/app/settings`, { headers: { cookie } })).json() as Promise<{ csrf: string; values: Record<string, unknown>; wordClips: Array<{ term: string; heard: string | null }> }>;
    const { csrf } = await settings();
    const send = (method: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${baseUrl}/api/app/words/clip`, { method, headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf, ...headers }, body: JSON.stringify(body) });
    const upload = (term: string, audio: Buffer = webm(), mimeType = "audio/webm;codecs=opus") => send("POST", { term, mimeType, audio: audio.toString("base64"), durationMs: 1_800 });
    const play = (term: string, headers: Record<string, string> = {}) => fetch(`${baseUrl}/api/app/words/clip?term=${encodeURIComponent(term)}`, { headers: { cookie, ...headers } });
    return { cookie, csrf, tenantId, settings, send, upload, play };
  }

  it("saves the clip, fills the word's 'sounds like' from what was heard, and plays it back", async () => {
    const shop = await signUp();
    const response = await shop.upload("Myakka");
    expect(response.status).toBe(200);
    const body = await response.json() as { heard: string; pronunciations: string };
    expect(body.heard).toBe("my AK uh");
    expect(body.pronunciations).toBe("Myakka: my AK uh");
    expect((await store.getConfig(shop.tenantId)).pronunciations).toEqual([{ term: "Myakka", spokenAs: "my AK uh" }]);
    expect((await shop.settings()).wordClips).toEqual([{ term: "Myakka", heard: "my AK uh", savedAt: "2026-11-26T15:00:00.000Z" }]);
    // Saying it again replaces the typed text for that word, matched without case.
    transcriber.answer = async () => "my ACK uh";
    await shop.upload("myakka", mp4(), "audio/mp4");
    expect((await store.getConfig(shop.tenantId)).pronunciations).toEqual([{ term: "Myakka", spokenAs: "my ACK uh" }]);
    // Speech-to-text often ends with a full stop or wraps it in quotes: "Sounds like" saves the words only.
    transcriber.answer = async () => " \"Kiss me.\" ";
    const quoted = await (await shop.upload("Kismet")).json() as { heard: string; pronunciations: string };
    expect(quoted.heard).toBe("Kiss me");
    expect((await store.getConfig(shop.tenantId)).pronunciations).toEqual([{ term: "Myakka", spokenAs: "my ACK uh" }, { term: "Kismet", spokenAs: "Kiss me" }]);
    expect((await shop.settings()).wordClips.find((clip) => clip.term === "Kismet")?.heard).toBe("Kiss me");
    const played = await shop.play("MYAKKA");
    expect(played.status).toBe(200);
    expect(played.headers.get("content-type")).toBe("audio/mp4");
    expect(Buffer.from(await played.arrayBuffer()).equals(mp4())).toBe(true);
    // iPhone Safari asks for byte ranges.
    const part = await shop.play("Myakka", { range: "bytes=0-1" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 0-1/2000");
    expect((await part.arrayBuffer()).byteLength).toBe(2);
    expect((await shop.play("Myakka", { range: "bytes=5000-" })).status).toBe(416);
  });

  it("keeps the clip and its check, and leaves the typed field alone, when speech-to-text fails or hears nothing", async () => {
    const shop = await signUp();
    const config = await store.getConfig(shop.tenantId);
    await store.saveConfig({ ...config, pronunciations: [{ term: "Venice", spokenAs: "VEN-iss" }] });
    transcriber.answer = async () => { throw new Error("provider down"); };
    const failed = await shop.upload("Venice");
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ heard: null, pronunciations: null });
    expect((await store.getConfig(shop.tenantId)).pronunciations).toEqual([{ term: "Venice", spokenAs: "VEN-iss" }]);
    expect((await shop.settings()).wordClips).toMatchObject([{ term: "Venice", heard: null }]);
    transcriber.answer = async () => " . ";
    await shop.upload("Osprey");
    expect((await store.getConfig(shop.tenantId)).pronunciations).toEqual([{ term: "Venice", spokenAs: "VEN-iss" }]);
    expect((await shop.play("Osprey")).status).toBe(200);
  });

  it("refuses what isn't a short clip of a typed word", async () => {
    const shop = await signUp();
    const cases: Array<[unknown, number]> = [
      [{ term: "", mimeType: "audio/webm", audio: webm().toString("base64") }, 400],
      [{ term: "a: b", mimeType: "audio/webm", audio: webm().toString("base64") }, 400],
      [{ term: "Myakka", mimeType: "text/html", audio: webm().toString("base64") }, 415],
      // Says webm, is not.
      [{ term: "Myakka", mimeType: "audio/webm", audio: mp4().toString("base64") }, 415],
      [{ term: "Myakka", mimeType: "audio/webm", audio: webm(200).toString("base64") }, 400],
      [{ term: "Myakka", mimeType: "audio/webm", audio: webm(WORD_CLIP_MAX_BYTES + 10).toString("base64") }, 413],
      [{ term: "Myakka", mimeType: "audio/webm", audio: webm().toString("base64"), durationMs: 30_000 }, 413],
      [{ term: "Myakka", mimeType: "audio/webm", audio: "not base64!" }, 400],
    ];
    for (const [body, status] of cases) expect((await shop.send("POST", body)).status, JSON.stringify(body).slice(0, 60)).toBe(status);
    // No CSRF header: refused.
    const noCsrf = await fetch(`${baseUrl}/api/app/words/clip`, { method: "POST", headers: { cookie: shop.cookie, "content-type": "application/json" }, body: JSON.stringify({ term: "Myakka", mimeType: "audio/webm", audio: webm().toString("base64") }) });
    expect(noCsrf.status).toBe(403);
    expect(await store.listWordClips(shop.tenantId)).toEqual([]);
    expect(transcriber.calls).toBe(0);
  });

  it("serves a clip only to a signed-in owner of that shop", async () => {
    const shop = await signUp("Synthetic Air");
    const other = await signUp("Synthetic Plumbing");
    await shop.upload("Myakka");
    expect((await fetch(`${baseUrl}/api/app/words/clip?term=Myakka`)).status).toBe(401);
    expect((await other.play("Myakka")).status).toBe(404);
    // Another shop can't remove it either.
    await other.send("DELETE", { term: "Myakka" });
    expect((await shop.play("Myakka")).status).toBe(200);
    expect((await other.settings()).wordClips).toEqual([]);
  });

  it("deletes the clip on Remove (the row's X removes it too) and with the shop", async () => {
    const shop = await signUp();
    await shop.upload("Myakka");
    await shop.upload("Venice");
    await shop.upload("Osprey");
    expect((await shop.send("DELETE", { term: "myakka" })).status).toBe(200);
    expect((await shop.play("Myakka")).status).toBe(404);
    // The typed text stays after removing just the recording.
    expect((await store.getConfig(shop.tenantId)).pronunciations.map((item) => item.term)).toEqual(["Myakka", "Venice", "Osprey"]);
    // A plain Save never drops a recording (a word still waiting for its "sounds like" keeps its check).
    const { values } = await shop.settings();
    const put = await fetch(`${baseUrl}/api/app/settings`, { method: "PUT", headers: { cookie: shop.cookie, "content-type": "application/json", "x-csrf-token": shop.csrf }, body: JSON.stringify({ ...values, pronunciations: "Venice: VEN-iss" }) });
    expect(put.status).toBe(200);
    expect((await store.listWordClips(shop.tenantId)).map((clip) => clip.term)).toEqual(["Venice", "Osprey"]);
    await store.deleteWorkspace(shop.tenantId);
    expect(await store.listWordClips(shop.tenantId)).toEqual([]);
    expect(store.wordClips.size).toBe(0);
  });

  it("allows the microphone on owner app pages only", async () => {
    const shop = await signUp();
    const app = await fetch(`${baseUrl}/app/settings/business`, { headers: { cookie: shop.cookie } });
    expect(app.status).toBe(200);
    expect(app.headers.get("permissions-policy")).toBe("camera=(), microphone=(self), geolocation=()");
    for (const path of ["/", "/signup", "/login", "/api/app/settings"]) {
      const response = await fetch(`${baseUrl}${path}`, { redirect: "manual", headers: { cookie: shop.cookie } });
      expect(response.headers.get("permissions-policy"), path).toBe("camera=(), microphone=(), geolocation=()");
    }
  });
});

describe("Say it reaches the live line (review of #82)", () => {
  const clock: Clock = { now: () => new Date("2026-11-26T15:00:00.000Z") };

  async function liveShop(assistantStatus: number) {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const webDir = await mkdtemp(join(tmpdir(), "afo-sayit-live-"));
    await writeFile(join(webDir, "index.html"), '<!doctype html><div id="root"></div>');
    const assistantUpdates: string[] = [];
    // Only the Telnyx assistant update is answered; anything else outbound fails the test.
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "https://api.telnyx.com/v2/ai/assistants/assistant_synthetic" && init?.method === "POST") {
        assistantUpdates.push(String(init.body));
        return new Response("{}", { status: assistantStatus });
      }
      throw new Error(`Unexpected outbound request in test: ${target}`);
    }) as typeof fetch;
    const base = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", PUBLIC_BASE_URL: "http://127.0.0.1:8787", TELNYX_API_KEY: "KEY_synthetic" });
    const transcriber: Transcriber = { transcribe: async () => "my AK uh" };
    const server = createServer(createRequestHandler({ env: { ...base, DEMO_MODE: false }, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: () => undefined, ownerWeb: { dir: webDir }, transcriber, fetcher }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const email = `owner-${Math.random().toString(36).slice(2, 8)}@synthetic.example`;
    const signup = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Synthetic Air", email, password: "long-password-for-tests", phone: "(941) 555-0142", trade: "hvac" }) });
    const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const tenantId = (await store.getOwnerAccountByEmail(email))!.tenantId;
    await store.saveProviderRoute({ provider: "telnyx", externalId: "assistant_synthetic", tenantId, createdAt: clock.now().toISOString(), updatedAt: clock.now().toISOString() });
    const { csrf } = await (await fetch(`${baseUrl}/api/app/settings`, { headers: { cookie } })).json() as { csrf: string };
    const upload = () => fetch(`${baseUrl}/api/app/words/clip`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ term: "Myakka", mimeType: "audio/webm", audio: webm().toString("base64"), durationMs: 1_800 }) });
    const close = async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(webDir, { recursive: true, force: true }); };
    return { store, tenantId, assistantUpdates, upload, close };
  }

  it("sends the new 'sounds like' to the live assistant before it shows as saved", async () => {
    const shop = await liveShop(200);
    try {
      const body = await (await shop.upload()).json() as { pronunciations: string | null };
      expect(body.pronunciations).toBe("Myakka: my AK uh");
      expect(shop.assistantUpdates).toHaveLength(1);
      expect(shop.assistantUpdates[0]).toContain("Myakka: pronounce as my AK uh");
      expect((await shop.store.getConfig(shop.tenantId)).pronunciations).toEqual([{ term: "Myakka", spokenAs: "my AK uh" }]);
    } finally { await shop.close(); }
  });

  it("keeps the clip and hands back what was heard, unsaved, when the live assistant refuses it", async () => {
    const shop = await liveShop(500);
    try {
      const response = await shop.upload();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ heard: "my AK uh", pronunciations: null });
      expect((await shop.store.getConfig(shop.tenantId)).pronunciations).toEqual([]);
      expect(await shop.store.listWordClips(shop.tenantId)).toMatchObject([{ term: "Myakka", heard: "my AK uh" }]);
    } finally { await shop.close(); }
  });

  it("names no speech-to-text model of its own: unset, clips are kept and nothing is transcribed", async () => {
    const { readFile: read } = await import("node:fs/promises");
    expect(await read(new URL("../src/adapters/telnyx-transcribe.ts", import.meta.url), "utf8")).not.toMatch(/whisper|DEFAULT_TELNYX_STT_MODEL/i);
    expect(demoEnvironment().TELNYX_STT_MODEL).toBeUndefined();
  });
});

describe("Names and words rows in the app", () => {
  it("shows a row per saved line and per said word, and saves only complete lines in the server's format", async () => {
    const { rowsFrom, textFrom, withLine } = await import("../web/src/lib/words.js");
    const rows = rowsFrom("Myakka: my-AK-uh\nVenice: VEN-iss", ["osprey", "MYAKKA"]);
    expect(rows.map((row) => [row.term, row.soundsLike])).toEqual([["Myakka", "my-AK-uh"], ["Venice", "VEN-iss"], ["osprey", ""]]);
    // Unchanged rows give back exactly the saved text, so nothing looks unsaved.
    expect(textFrom(rows)).toBe("Myakka: my-AK-uh\nVenice: VEN-iss");
    expect(withLine("Myakka: old\nVenice: VEN-iss", "myakka", "my AK uh")).toBe("Myakka: my AK uh\nVenice: VEN-iss");
    expect(withLine("Venice: VEN-iss", "Osprey", "OSS-pray")).toBe("Venice: VEN-iss\nOsprey: OSS-pray");
  });

  it("puts a late 'sounds like' on the word it was said for and keeps every newer edit (review of #82)", async () => {
    const { rowsFrom, textFrom, withHeard } = await import("../web/src/lib/words.js");
    // Said "Myakka", then while it saved: renamed that row, fixed Venice, and started Osprey.
    const rows = rowsFrom("Myakka: old\nVenice: VEN-iss")
    const edited = [{ ...rows[0]!, term: "Myakka River" }, { ...rows[1]!, soundsLike: "VEH-niss" }, { id: "typing", term: "Osprey", soundsLike: "" }];
    const next = withHeard(edited, "Myakka", "my AK uh");
    expect(next.map((row) => [row.term, row.soundsLike])).toEqual([["Myakka River", "old"], ["Venice", "VEH-niss"], ["Osprey", ""], ["Myakka", "my AK uh"]]);
    expect(textFrom(next)).toBe("Myakka River: old\nVenice: VEH-niss\nMyakka: my AK uh");
    // The row still has the word: only its "sounds like" changes.
    expect(withHeard(rowsFrom("Myakka: old"), "MYAKKA", "new").map((row) => row.soundsLike)).toEqual(["new"]);
  });

  it("takes a saved value from outside without dropping a row being typed or changing row ids", async () => {
    const { mergeRows, rowsFrom } = await import("../web/src/lib/words.js");
    const current = [...rowsFrom("Myakka: old"), { id: "typing", term: "Osprey", soundsLike: "" }, { id: "blank", term: "", soundsLike: "" }];
    const merged = mergeRows(current, "Venice: VEN-iss\nMyakka: my AK uh", ["Myakka"]);
    expect(merged.map((row) => [row.term, row.soundsLike])).toEqual([["Venice", "VEN-iss"], ["Myakka", "my AK uh"], ["Osprey", ""], ["", ""]]);
    expect(merged[1]!.id).toBe(current[0]!.id);
    expect(merged.slice(2).map((row) => row.id)).toEqual(["typing", "blank"]);
    // Discard drops a finished line that was never saved.
    expect(mergeRows([{ id: "x", term: "Venice", soundsLike: "VEN-iss" }], "").map((row) => row.term)).toEqual([]);
  });
});
