import { afterEach, describe, expect, it } from "vitest";
import { callsCsv, callsCsvFileName } from "../src/http/calls-csv.js";
import { acConversation, liveShop, type LiveShop } from "./support/live-shop.js";

/** Walk 3 (CALL-09, CALL-11): the export was named front-office-calls, and the call's address, problem and outcome were blank or stale. */
describe("the calls spreadsheet after a real shop call", () => {
  let shop: LiveShop;
  afterEach(async () => { await shop?.close(); });
  const CALL = "v3:csv-call-1";

  const exportCsv = async () => {
    const response = await fetch(`${shop.baseUrl}/api/app/shops/${shop.tenantId}/calls.csv`, { headers: { cookie: shop.cookie } });
    expect(response.status).toBe(200);
    return { name: response.headers.get("content-disposition"), lines: (await response.text()).replace(/^﻿/, "").trimEnd().split("\r\n") };
  };

  it("is named for Call Otto and carries the address, problem and outcome Otto captured", async () => {
    shop = await liveShop();
    expect((await shop.init(CALL)).status).toBe(200);
    const history = acConversation(CALL, shop.clock.iso());
    shop.clock.advance(31);
    // The walk's shape: the end-of-call callback never arrives; the call is finished from Telnyx's history.
    shop.telnyx.calls.set(CALL, { is_alive: false, call_duration: 31, end_time: shop.clock.iso() });
    shop.telnyx.keepConversation(CALL, history, history[history.length - 1]!.sent_at!);
    shop.clock.advance(120);
    await shop.recovery.runOnce();

    const { name, lines } = await exportCsv();
    expect(name).toBe('attachment; filename="call-otto-calls-2026-11-23.csv"');
    expect(name).not.toContain("front-office");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Dana Miller","(555) 555-0110","100 Main Street, Sarasota FL","AC stopped cooling this morning","Needs your OK"');
  });

  it("never exports a call that hung up as still on the call", async () => {
    shop = await liveShop();
    await shop.init(CALL);
    shop.clock.advance(20 * 60);
    const { lines } = await exportCsv();
    expect(lines[1]).toMatch(/"Call ended"$/);
    expect(lines[1]).toContain('"(555) 555-0110"');
  });

  it("keeps a call that is really up as on the call, and names the file by the day", async () => {
    shop = await liveShop();
    await shop.init(CALL);
    const call = (await shop.store.getCallByProviderId(CALL))!;
    expect(callsCsv([call], "America/New_York", shop.clock.now())).toMatch(/"On the call"\r\n$/);
    expect(callsCsv([{ ...call, endedAt: shop.clock.iso() }], "America/New_York", shop.clock.now())).toMatch(/"Call ended"\r\n$/);
    expect(callsCsvFileName(new Date("2026-11-26T23:00:00Z"))).toBe("call-otto-calls-2026-11-26.csv");
  });

  it("never lets a callback number written in words hide the number that called", async () => {
    shop = await liveShop();
    await shop.init(CALL);
    const call = (await shop.store.getCallByProviderId(CALL))!;
    const old = { ...call, fields: { ...call.fields, callbackNumber: "same number" }, endedAt: shop.clock.iso() };
    expect(callsCsv([old], "America/New_York", shop.clock.now())).toContain('"(555) 555-0110"');
    expect(callsCsv([old], "America/New_York", shop.clock.now())).not.toContain("same number");
  });
});
