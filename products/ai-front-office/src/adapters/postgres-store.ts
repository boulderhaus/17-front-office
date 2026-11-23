import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import type { Store } from "../ports.js";
import type { BookingRecord, BusinessConfig, CallbackTask, CallRecord, CustomerRecord, OutboxNotification, OwnerAccount, OwnerWorkspaceInput, PilotSignup, ProviderRoute, SubscriptionRecord, ToolEvent, UsageSummary } from "../domain/models.js";
import { CryptoBox } from "../security/crypto-box.js";
import { normalizeBusinessConfig } from "../domain/config.js";
import { MIN_BILLABLE_CALL_SECONDS } from "../domain/usage.js";

const { Pool } = pg;

type Row = Record<string, unknown>;

export class PostgresStore implements Store {
  readonly #pool: pg.Pool;
  readonly #lockPool: pg.Pool;
  readonly #lockSession = new AsyncLocalStorage<{ client: pg.PoolClient; held: Set<string>; broken: boolean }>();

  constructor(databaseUrl: string, private readonly cryptoBox: CryptoBox) {
    this.#pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 3_000 });
    // Advisory locks must not consume the same pool used by the work inside the
    // critical section. A burst of lock holders would otherwise starve their
    // own queries and deadlock at the pool limit.
    this.#lockPool = new Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 3_000 });
  }

  async close(): Promise<void> {
    await Promise.all([this.#pool.end(), this.#lockPool.end()]);
  }

  async ping(): Promise<void> {
    await this.#pool.query("SELECT 1");
  }

  /**
   * Session-level advisory locks. Nested locks (call -> calendar, config ->
   * assistant-config) reuse the outer session, so one operation never needs two
   * lock connections: before this, five overlapping bookings exhausted the pool
   * and all of them failed. Waits are bounded with try-lock polling because
   * lock_timeout does not bound pg_advisory_lock in practice.
   */
  async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const current = this.#lockSession.getStore();
    if (current) {
      if (current.held.has(key)) return task();
      await acquireAdvisoryLock(current.client, key);
      current.held.add(key);
      try {
        return await task();
      } finally {
        current.held.delete(key);
        await releaseAdvisoryLock(current.client, key).catch(() => { current.broken = true; });
      }
    }
    const client = await this.#lockPool.connect();
    const session = { client, held: new Set([key]), broken: false };
    try {
      await acquireAdvisoryLock(client, key);
    } catch (error) {
      client.release();
      throw error;
    }
    try {
      return await this.#lockSession.run(session, task);
    } finally {
      await releaseAdvisoryLock(client, key).catch(() => { session.broken = true; });
      // A session that may still hold a lock must never return to the pool.
      client.release(session.broken);
    }
  }

  async claimWebhook(eventId: string): Promise<boolean> {
    const result = await this.#pool.query(
      "INSERT INTO webhook_events(event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
      [eventId],
    );
    return result.rowCount === 1;
  }

  async listTenantIds(): Promise<string[]> {
    const result = await this.#pool.query("SELECT tenant_id FROM business_configs ORDER BY tenant_id");
    return result.rows.map((row) => String(row.tenant_id));
  }

  async getConfig(tenantId: string): Promise<BusinessConfig> {
    const result = await this.#pool.query("SELECT config FROM business_configs WHERE tenant_id = $1", [tenantId]);
    if (!result.rows[0]) throw new Error(`No business configuration for tenant ${tenantId}`);
    return normalizeBusinessConfig(result.rows[0].config as Partial<BusinessConfig> & Pick<BusinessConfig, "tenantId">);
  }

  async saveConfig(config: BusinessConfig): Promise<void> {
    await this.#pool.query(
      `INSERT INTO business_configs(tenant_id, config, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (tenant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
      [config.tenantId, config],
    );
  }

  async getIntegrationSecret(tenantId: string, provider: string, key: string): Promise<string | null> {
    const result = await this.#pool.query(
      "SELECT value_ciphertext FROM integration_secrets WHERE tenant_id=$1 AND provider=$2 AND secret_key=$3",
      [tenantId, provider, key],
    );
    if (!result.rows[0]) return null;
    return this.cryptoBox.decrypt(String(result.rows[0].value_ciphertext));
  }

  async deleteIntegrationSecret(tenantId: string, provider: string, key: string): Promise<void> {
    await this.#pool.query("DELETE FROM integration_secrets WHERE tenant_id=$1 AND provider=$2 AND secret_key=$3", [tenantId, provider, key]);
  }

  async saveIntegrationSecret(tenantId: string, provider: string, key: string, value: string): Promise<void> {
    // Only values we must find by content get a keyed lookup hash; every other secret stays opaque.
    const lookupHash = provider === "telnyx" && key === "inbound_number" ? this.cryptoBox.hashLookup(value) : null;
    await this.#pool.query(
      `INSERT INTO integration_secrets(tenant_id,provider,secret_key,value_ciphertext,lookup_hash,updated_at)
       VALUES($1,$2,$3,$4,$5,now())
       ON CONFLICT (tenant_id,provider,secret_key) DO UPDATE SET value_ciphertext=EXCLUDED.value_ciphertext,lookup_hash=EXCLUDED.lookup_hash,updated_at=now()`,
      [tenantId, provider, key, this.cryptoBox.encrypt(value), lookupHash],
    );
  }

  async getTenantIdByInboundNumber(phoneNumber: string): Promise<string | null> {
    const result = await this.#pool.query(
      `SELECT tenant_id, value_ciphertext FROM integration_secrets
       WHERE provider='telnyx' AND secret_key='inbound_number' AND lookup_hash=$1
       ORDER BY updated_at DESC`,
      [this.cryptoBox.hashLookup(phoneNumber)],
    );
    for (const row of result.rows) {
      if (this.cryptoBox.decrypt(String(row.value_ciphertext)) === phoneNumber) return String(row.tenant_id);
    }
    return null;
  }

  async getCallByProviderId(providerCallId: string): Promise<CallRecord | null> {
    const result = await this.#pool.query("SELECT * FROM calls WHERE provider_call_id = $1", [providerCallId]);
    return result.rows[0] ? this.mapCall(result.rows[0] as Row) : null;
  }

  async isProviderCallDeleted(providerCallId: string): Promise<boolean> {
    const result = await this.#pool.query("SELECT 1 FROM deleted_provider_calls WHERE provider_call_id=$1", [providerCallId]);
    return result.rowCount === 1;
  }

  async getCall(callId: string): Promise<CallRecord | null> {
    const result = await this.#pool.query("SELECT * FROM calls WHERE id = $1", [callId]);
    return result.rows[0] ? this.mapCall(result.rows[0] as Row) : null;
  }

  async saveCall(call: CallRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO calls(
         id, tenant_id, provider_call_id, from_number_hash, from_number_ciphertext, from_number_verified, started_at, ended_at,
         duration_seconds, fields_ciphertext, emergency, outcome, transcript_ciphertext,
         recording_url_ciphertext, consent_state, billing_disposition, quality_flags, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (id) DO UPDATE SET
         from_number_hash = EXCLUDED.from_number_hash,
         from_number_ciphertext = EXCLUDED.from_number_ciphertext,
         from_number_verified = EXCLUDED.from_number_verified,
         started_at = EXCLUDED.started_at,
         ended_at = EXCLUDED.ended_at,
         duration_seconds = EXCLUDED.duration_seconds,
         fields_ciphertext = EXCLUDED.fields_ciphertext,
         emergency = EXCLUDED.emergency,
         outcome = EXCLUDED.outcome,
         transcript_ciphertext = EXCLUDED.transcript_ciphertext,
         recording_url_ciphertext = EXCLUDED.recording_url_ciphertext,
         consent_state = EXCLUDED.consent_state,
         billing_disposition = EXCLUDED.billing_disposition,
         quality_flags = EXCLUDED.quality_flags,
         updated_at = EXCLUDED.updated_at`,
      [
        call.id,
        call.tenantId,
        call.providerCallId,
        this.cryptoBox.hashLookup(call.fromNumber),
        this.cryptoBox.encrypt(call.fromNumber),
        call.fromNumberVerified,
        call.startedAt,
        call.endedAt,
        call.durationSeconds,
        this.cryptoBox.encrypt(JSON.stringify(call.fields)),
        call.emergency,
        call.outcome,
        this.cryptoBox.encrypt(call.transcript),
        this.cryptoBox.encrypt(call.recordingUrl),
        call.consentState,
        call.billingDisposition,
        JSON.stringify(call.qualityFlags),
        call.createdAt,
        call.updatedAt,
      ],
    );
  }

  async listCalls(tenantId: string, limit: number): Promise<CallRecord[]> {
    const result = await this.#pool.query("SELECT * FROM calls WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2", [tenantId, limit]);
    return result.rows.map((row) => this.mapCall(row as Row));
  }

  async countCallsFromNumberSince(tenantId: string, phone: string, since: string): Promise<number> {
    const result = await this.#pool.query(
      "SELECT count(*)::int AS count FROM calls WHERE tenant_id=$1 AND from_number_hash=$2 AND started_at >= $3",
      [tenantId, this.cryptoBox.hashLookup(phone), since],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listExpiredCalls(tenantId: string, endedBefore: string, limit: number, now: string): Promise<CallRecord[]> {
    const result = await this.#pool.query(
      `SELECT * FROM calls WHERE tenant_id=$1 AND ended_at IS NOT NULL AND ended_at < $2
         AND (retention_failed_at IS NULL OR retention_failed_at < $4::timestamptz - interval '24 hours')
       ORDER BY ended_at LIMIT $3`,
      [tenantId, endedBefore, limit, now],
    );
    return result.rows.map((row) => this.mapCall(row as Row));
  }

  async deleteCall(tenantId: string, callId: string): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query("SELECT provider_call_id FROM calls WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, callId]);
      if (!selected.rows[0]) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        "INSERT INTO deleted_provider_calls(provider_call_id,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [selected.rows[0].provider_call_id, tenantId],
      );
      await client.query("DELETE FROM calls WHERE tenant_id=$1 AND id=$2", [tenantId, callId]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteWorkspace(tenantId: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO deleted_provider_calls(provider_call_id,tenant_id) SELECT provider_call_id,tenant_id FROM calls WHERE tenant_id=$1 ON CONFLICT DO NOTHING",
        [tenantId],
      );
      // Outbox rows without a call (welcome, billing notices) are not covered by the call cascade.
      await client.query("DELETE FROM notification_outbox WHERE tenant_id=$1", [tenantId]);
      await client.query("DELETE FROM tool_events WHERE tenant_id=$1", [tenantId]);
      await client.query("DELETE FROM business_configs WHERE tenant_id=$1", [tenantId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markRetentionFailed(callId: string, at: string): Promise<void> {
    await this.#pool.query("UPDATE calls SET retention_failed_at=$2 WHERE id=$1", [callId, at]);
  }

  async upsertCustomer(customer: CustomerRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO customers(id,tenant_id,phone_hash,phone_ciphertext,name_ciphertext,address_ciphertext,last_call_id,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id,phone_hash) DO UPDATE SET
         phone_ciphertext=EXCLUDED.phone_ciphertext,name_ciphertext=EXCLUDED.name_ciphertext,
         address_ciphertext=EXCLUDED.address_ciphertext,last_call_id=EXCLUDED.last_call_id,updated_at=EXCLUDED.updated_at`,
      [customer.id, customer.tenantId, this.cryptoBox.hashLookup(customer.phone), this.cryptoBox.encrypt(customer.phone),
        this.cryptoBox.encrypt(customer.name), this.cryptoBox.encrypt(customer.address), customer.lastCallId,
        customer.createdAt, customer.updatedAt],
    );
  }

  async getBookingForCall(callId: string): Promise<BookingRecord | null> {
    const result = await this.#pool.query("SELECT * FROM booking_requests WHERE call_id = $1", [callId]);
    return result.rows[0] ? mapBooking(result.rows[0] as Row) : null;
  }

  async saveBooking(booking: BookingRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO booking_requests(id,tenant_id,call_id,requested_start,requested_end,status,provider_event_id,write_verified_at,confirmation_notification_id,verification_failures,failure_reason,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (call_id) DO UPDATE SET requested_start=EXCLUDED.requested_start,requested_end=EXCLUDED.requested_end,
         status=EXCLUDED.status,provider_event_id=EXCLUDED.provider_event_id,write_verified_at=EXCLUDED.write_verified_at,
         confirmation_notification_id=EXCLUDED.confirmation_notification_id,verification_failures=EXCLUDED.verification_failures,
         failure_reason=EXCLUDED.failure_reason,updated_at=EXCLUDED.updated_at`,
      [booking.id, booking.tenantId, booking.callId, booking.requestedStart, booking.requestedEnd, booking.status,
        booking.providerEventId, booking.writeVerifiedAt, booking.confirmationNotificationId, JSON.stringify(booking.verificationFailures),
        booking.failureReason, booking.createdAt, booking.updatedAt],
    );
  }

  async getCallbackTaskForCall(callId: string): Promise<CallbackTask | null> {
    const result = await this.#pool.query("SELECT * FROM callback_tasks WHERE call_id=$1", [callId]);
    return result.rows[0] ? mapCallbackTask(result.rows[0] as Row) : null;
  }

  async listOpenCallbackTasks(tenantId: string, limit: number): Promise<CallbackTask[]> {
    const result = await this.#pool.query(
      `SELECT * FROM callback_tasks
       WHERE tenant_id=$1 AND status='open'
       ORDER BY CASE WHEN priority='high' THEN 0 ELSE 1 END, due_at ASC
       LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows.map((row) => mapCallbackTask(row as Row));
  }

  async listCallbackTasks(tenantId: string, limit: number): Promise<CallbackTask[]> {
    const result = await this.#pool.query(
      `SELECT * FROM callback_tasks
       WHERE tenant_id=$1
       ORDER BY updated_at DESC
       LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows.map((row) => mapCallbackTask(row as Row));
  }

  async saveCallbackTask(task: CallbackTask): Promise<void> {
    await this.#pool.query(
      `INSERT INTO callback_tasks(id,tenant_id,call_id,owner_ref,reason,priority,status,due_at,completed_at,completion_source,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (call_id) DO UPDATE SET owner_ref=EXCLUDED.owner_ref,reason=EXCLUDED.reason,priority=EXCLUDED.priority,
         status=EXCLUDED.status,due_at=EXCLUDED.due_at,completed_at=EXCLUDED.completed_at,
         completion_source=EXCLUDED.completion_source,updated_at=EXCLUDED.updated_at`,
      [task.id, task.tenantId, task.callId, task.ownerRef, task.reason, task.priority, task.status, task.dueAt,
        task.completedAt, task.completionSource, task.createdAt, task.updatedAt],
    );
  }

  async addToolEvent(event: ToolEvent): Promise<void> {
    await this.#pool.query(
      `INSERT INTO tool_events(id,tenant_id,call_id,tool,started_at,completed_at,latency_ms,result,metadata,redacted_error)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [event.id, event.tenantId, event.callId, event.tool, event.startedAt, event.completedAt, event.latencyMs, event.result, event.metadata, event.redactedError],
    );
  }

  async listToolEvents(callId: string): Promise<ToolEvent[]> {
    const result = await this.#pool.query("SELECT * FROM tool_events WHERE call_id = $1 ORDER BY started_at", [callId]);
    return result.rows.map((row) => mapToolEvent(row as Row));
  }

  async enqueueNotification(notification: OutboxNotification): Promise<boolean> {
    const result = await this.#pool.query(
      `INSERT INTO notification_outbox(id,tenant_id,call_id,channel,sender_ref,destination_ref_ciphertext,body_ciphertext,priority,state,attempts,next_attempt_at,idempotency_key,provider_receipt,last_error,created_at,sent_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [notification.id, notification.tenantId, notification.callId, notification.channel, notification.senderRef ?? "default", this.cryptoBox.encrypt(notification.destinationRef), this.cryptoBox.encrypt(notification.body), notification.priority, notification.state, notification.attempts, notification.nextAttemptAt, notification.idempotencyKey, notification.providerReceipt, notification.lastError, notification.createdAt, notification.sentAt],
    );
    return result.rowCount === 1;
  }

  async claimDueNotifications(now: string, limit: number): Promise<OutboxNotification[]> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT * FROM notification_outbox
         WHERE state IN ('pending','retry') AND next_attempt_at <= $1
         ORDER BY CASE WHEN priority = 'high' THEN 0 ELSE 1 END, created_at
         FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, limit],
      );
      const ids = result.rows.map((row) => row.id as string);
      if (ids.length > 0) {
        await client.query("UPDATE notification_outbox SET state='sending', attempts=attempts+1, sending_at=now() WHERE id = ANY($1::uuid[])", [ids]);
      }
      await client.query("COMMIT");
      return result.rows.map((row) => mapNotification({ ...row, state: "sending", attempts: Number(row.attempts) + 1 } as Row, this.cryptoBox));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async requeueStaleNotifications(staleBefore: string, now: string): Promise<number> {
    const result = await this.#pool.query(
      `UPDATE notification_outbox SET state='retry',next_attempt_at=$2,sending_at=NULL,last_error='Recovered after interrupted delivery'
       WHERE state='sending' AND sending_at < $1`,
      [staleBefore, now],
    );
    return result.rowCount ?? 0;
  }

  async saveNotification(notification: OutboxNotification): Promise<void> {
    await this.#pool.query(
      `UPDATE notification_outbox SET state=$2,attempts=$3,next_attempt_at=$4,provider_receipt=$5,last_error=$6,sent_at=$7,sending_at=NULL WHERE id=$1`,
      [notification.id, notification.state, notification.attempts, notification.nextAttemptAt, notification.providerReceipt, notification.lastError, notification.sentAt],
    );
  }

  async cancelPendingNotification(idempotencyKey: string): Promise<boolean> {
    // Claiming holds the row lock and moves it to 'sending'; this re-checks the state after any wait.
    const result = await this.#pool.query(
      "UPDATE notification_outbox SET state='cancelled' WHERE idempotency_key=$1 AND state='pending' RETURNING id",
      [idempotencyKey],
    );
    return result.rowCount === 1;
  }

  async getNotificationByProviderReceipt(providerReceipt: string): Promise<OutboxNotification | null> {
    const result = await this.#pool.query("SELECT * FROM notification_outbox WHERE provider_receipt=$1", [providerReceipt]);
    return result.rows[0] ? mapNotification(result.rows[0] as Row, this.cryptoBox) : null;
  }

  async listNotifications(callId: string): Promise<OutboxNotification[]> {
    const result = await this.#pool.query("SELECT * FROM notification_outbox WHERE call_id=$1 ORDER BY created_at", [callId]);
    return result.rows.map((row) => mapNotification(row as Row, this.cryptoBox));
  }


  async setSmsOptOut(tenantId: string, phone: string, optedOut: boolean): Promise<void> {
    await this.#pool.query(
      `INSERT INTO sms_opt_outs(tenant_id,phone_hash,opted_out,updated_at) VALUES($1,$2,$3,now())
       ON CONFLICT (tenant_id,phone_hash) DO UPDATE SET opted_out=EXCLUDED.opted_out,updated_at=now()`,
      [tenantId, this.cryptoBox.hashLookup(phone), optedOut],
    );
  }

  async isSmsOptedOut(tenantId: string, phone: string): Promise<boolean> {
    const result = await this.#pool.query("SELECT opted_out FROM sms_opt_outs WHERE tenant_id=$1 AND phone_hash=$2", [tenantId, this.cryptoBox.hashLookup(phone)]);
    return result.rows[0]?.opted_out === true;
  }

  async savePilotSignup(signup: PilotSignup): Promise<void> {
    await this.#pool.query(
      `INSERT INTO pilot_signups(
         id,owner_name_ciphertext,business_name_ciphertext,email_hash,email_ciphertext,phone_hash,phone_ciphertext,
         website_ciphertext,trade,service_area_ciphertext,desired_mode,missed_calls_per_week,calendar_provider,
         notes_ciphertext,status,source,consented_at,created_at,updated_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (email_hash) DO UPDATE SET
         owner_name_ciphertext=EXCLUDED.owner_name_ciphertext,
         business_name_ciphertext=EXCLUDED.business_name_ciphertext,
         email_ciphertext=EXCLUDED.email_ciphertext,
         phone_hash=EXCLUDED.phone_hash,
         phone_ciphertext=EXCLUDED.phone_ciphertext,
         website_ciphertext=EXCLUDED.website_ciphertext,
         trade=EXCLUDED.trade,
         service_area_ciphertext=EXCLUDED.service_area_ciphertext,
         desired_mode=EXCLUDED.desired_mode,
         missed_calls_per_week=EXCLUDED.missed_calls_per_week,
         calendar_provider=EXCLUDED.calendar_provider,
         notes_ciphertext=EXCLUDED.notes_ciphertext,
         consented_at=EXCLUDED.consented_at,
         updated_at=EXCLUDED.updated_at`,
      [
        signup.id,
        this.cryptoBox.encrypt(signup.ownerName),
        this.cryptoBox.encrypt(signup.businessName),
        this.cryptoBox.hashLookup(signup.email),
        this.cryptoBox.encrypt(signup.email),
        this.cryptoBox.hashLookup(signup.phone),
        this.cryptoBox.encrypt(signup.phone),
        this.cryptoBox.encrypt(signup.website),
        signup.trade,
        this.cryptoBox.encrypt(signup.serviceArea),
        signup.desiredMode,
        signup.missedCallsPerWeek,
        signup.calendarProvider,
        this.cryptoBox.encrypt(signup.notes),
        signup.status,
        signup.source,
        signup.consentedAt,
        signup.createdAt,
        signup.updatedAt,
      ],
    );
  }

  async listPilotSignups(limit: number): Promise<PilotSignup[]> {
    const result = await this.#pool.query("SELECT * FROM pilot_signups ORDER BY created_at DESC LIMIT $1", [limit]);
    return result.rows.map((row) => mapPilotSignup(row as Row, this.cryptoBox));
  }

  async createOwnerWorkspace(input: OwnerWorkspaceInput): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO business_configs(tenant_id,config,updated_at) VALUES($1,$2,now())
         ON CONFLICT (tenant_id) DO UPDATE SET config=EXCLUDED.config,updated_at=now()`,
        [input.config.tenantId, input.config],
      );
      if (input.ownerPhone) {
        await client.query(
          `INSERT INTO integration_secrets(tenant_id,provider,secret_key,value_ciphertext,updated_at)
           VALUES($1,'notifications','owner-primary',$2,now())
           ON CONFLICT (tenant_id,provider,secret_key) DO UPDATE SET value_ciphertext=EXCLUDED.value_ciphertext,updated_at=now()`,
          [input.config.tenantId, this.cryptoBox.encrypt(input.ownerPhone)],
        );
      }
      await client.query(
        `INSERT INTO owner_accounts(id,tenant_id,email_hash,email_ciphertext,display_name_ciphertext,password_hash,status,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [input.account.id, input.account.tenantId, this.cryptoBox.hashLookup(input.account.email), this.cryptoBox.encrypt(input.account.email),
          this.cryptoBox.encrypt(input.account.displayName), input.account.passwordHash, input.account.status, input.account.createdAt, input.account.updatedAt],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isUniqueViolation(error)) return false;
      throw error;
    } finally {
      client.release();
    }
  }

  async getOwnerAccountByEmail(email: string): Promise<OwnerAccount | null> {
    const result = await this.#pool.query("SELECT * FROM owner_accounts WHERE email_hash=$1", [this.cryptoBox.hashLookup(email)]);
    return result.rows[0] ? mapOwnerAccount(result.rows[0] as Row, this.cryptoBox) : null;
  }

  async createTeamAccount(account: OwnerAccount): Promise<boolean> {
    try {
      await this.#pool.query(
        `INSERT INTO owner_accounts(id,tenant_id,email_hash,email_ciphertext,display_name_ciphertext,password_hash,status,role,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'member',$8,$9)`,
        [account.id, account.tenantId, this.cryptoBox.hashLookup(account.email), this.cryptoBox.encrypt(account.email), this.cryptoBox.encrypt(account.displayName), account.passwordHash, account.status, account.createdAt, account.updatedAt],
      );
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async listTeamAccounts(tenantId: string): Promise<OwnerAccount[]> {
    const result = await this.#pool.query("SELECT * FROM owner_accounts WHERE tenant_id=$1 ORDER BY created_at,id", [tenantId]);
    return result.rows.map((row) => mapOwnerAccount(row as Row, this.cryptoBox));
  }

  async getOwnerAccountById(accountId: string): Promise<OwnerAccount | null> {
    const result = await this.#pool.query("SELECT * FROM owner_accounts WHERE id=$1", [accountId]);
    return result.rows[0] ? mapOwnerAccount(result.rows[0] as Row, this.cryptoBox) : null;
  }

  async getOwnerAccountByTenant(tenantId: string): Promise<OwnerAccount | null> {
    const result = await this.#pool.query("SELECT * FROM owner_accounts WHERE tenant_id=$1 AND role='owner'", [tenantId]);
    return result.rows[0] ? mapOwnerAccount(result.rows[0] as Row, this.cryptoBox) : null;
  }

  async listOwnerAccounts(limit: number): Promise<OwnerAccount[]> {
    const result = await this.#pool.query("SELECT * FROM owner_accounts WHERE role='owner' ORDER BY created_at DESC LIMIT $1", [limit]);
    return result.rows.map((row) => mapOwnerAccount(row as Row, this.cryptoBox));
  }

  async createPasswordReset(accountId: string, tokenHash: string, expiresAt: string): Promise<void> {
    await this.#pool.query("INSERT INTO password_reset_tokens(token_hash,account_id,expires_at) VALUES($1,$2,$3)", [tokenHash, accountId, expiresAt]);
  }

  async consumePasswordReset(tokenHash: string, now: string): Promise<string | null> {
    const result = await this.#pool.query(
      "UPDATE password_reset_tokens SET used_at=$2 WHERE token_hash=$1 AND used_at IS NULL AND expires_at > $2 RETURNING account_id",
      [tokenHash, now],
    );
    return result.rows[0] ? String(result.rows[0].account_id) : null;
  }

  async updateOwnerPassword(accountId: string, passwordHash: string, updatedAt: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE owner_accounts SET password_hash=$2, session_version=session_version+1, updated_at=$3 WHERE id=$1", [accountId, passwordHash, updatedAt]);
      await client.query("DELETE FROM password_reset_tokens WHERE account_id=$1", [accountId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listBookingsForTenant(tenantId: string): Promise<BookingRecord[]> {
    const result = await this.#pool.query("SELECT * FROM booking_requests WHERE tenant_id=$1 ORDER BY created_at", [tenantId]);
    return result.rows.map((row) => mapBooking(row as Row));
  }

  async revokeOwnerSessions(accountId: string, updatedAt: string): Promise<void> {
    await this.#pool.query("UPDATE owner_accounts SET session_version=session_version+1, updated_at=$2 WHERE id=$1", [accountId, updatedAt]);
  }

  async updateOwnerAccountStatus(accountId: string, status: OwnerAccount["status"], updatedAt: string): Promise<boolean> {
    const result = await this.#pool.query("UPDATE owner_accounts SET status=$2,updated_at=$3 WHERE id=$1", [accountId, status, updatedAt]);
    return result.rowCount === 1;
  }

  async getUsageSummary(tenantId: string, periodStart: string, periodEnd: string): Promise<UsageSummary> {
    // Same rules as usageClass(): spam never counts, nor does a call under MIN_BILLABLE_CALL_SECONDS ($4).
    const result = await this.#pool.query(
      `WITH period AS (
         SELECT
           CASE
             WHEN billing_disposition='spam_excluded' OR outcome='ignored_spam' THEN 'spam'
             WHEN billing_disposition<>'billable' THEN 'not_billable'
             WHEN COALESCE(duration_seconds,0) < $4 THEN 'short'
             ELSE 'billable'
           END AS usage_class,
           duration_seconds
         FROM calls WHERE tenant_id=$1 AND started_at >= $2 AND started_at < $3
       )
       SELECT
         count(*) FILTER (WHERE usage_class='billable')::int AS billable_calls,
         count(*) FILTER (WHERE usage_class='spam')::int AS excluded_spam_calls,
         count(*) FILTER (WHERE usage_class='short')::int AS excluded_short_calls,
         COALESCE(sum(ceil(duration_seconds::numeric / 60)) FILTER (WHERE usage_class='billable'),0)::int AS billed_minutes
       FROM period`,
      [tenantId, periodStart, periodEnd, MIN_BILLABLE_CALL_SECONDS],
    );
    return {
      periodStart,
      periodEnd,
      billableCalls: Number(result.rows[0]?.billable_calls ?? 0),
      excludedSpamCalls: Number(result.rows[0]?.excluded_spam_calls ?? 0),
      excludedShortCalls: Number(result.rows[0]?.excluded_short_calls ?? 0),
      billedMinutes: Number(result.rows[0]?.billed_minutes ?? 0),
    };
  }

  async saveProviderRoute(route: ProviderRoute): Promise<void> {
    await this.#pool.query(
      `INSERT INTO provider_routes(provider,external_id,tenant_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (provider,external_id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,updated_at=EXCLUDED.updated_at`,
      [route.provider, route.externalId, route.tenantId, route.createdAt, route.updatedAt],
    );
  }

  async getProviderRoute(provider: ProviderRoute["provider"], externalId: string): Promise<ProviderRoute | null> {
    const result = await this.#pool.query("SELECT * FROM provider_routes WHERE provider=$1 AND external_id=$2", [provider, externalId]);
    const row = result.rows[0] as Row | undefined;
    return row ? {
      provider: row.provider as ProviderRoute["provider"],
      externalId: String(row.external_id),
      tenantId: String(row.tenant_id),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    } : null;
  }

  async getProviderRouteForTenant(provider: ProviderRoute["provider"], tenantId: string): Promise<ProviderRoute | null> {
    const result = await this.#pool.query("SELECT * FROM provider_routes WHERE provider=$1 AND tenant_id=$2 ORDER BY updated_at DESC LIMIT 1", [provider, tenantId]);
    const row = result.rows[0] as Row | undefined;
    return row ? {
      provider: row.provider as ProviderRoute["provider"],
      externalId: String(row.external_id),
      tenantId: String(row.tenant_id),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    } : null;
  }

  async saveSubscription(subscription: SubscriptionRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO tenant_subscriptions(tenant_id,provider_customer_id,provider_subscription_id,status,current_period_end,provider_event_created_at,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id) DO UPDATE SET provider_customer_id=EXCLUDED.provider_customer_id,
         provider_subscription_id=EXCLUDED.provider_subscription_id,status=EXCLUDED.status,
         current_period_end=EXCLUDED.current_period_end,provider_event_created_at=EXCLUDED.provider_event_created_at,
         updated_at=EXCLUDED.updated_at
       WHERE tenant_subscriptions.provider_event_created_at <= EXCLUDED.provider_event_created_at`,
      [subscription.tenantId, subscription.providerCustomerId, subscription.providerSubscriptionId, subscription.status,
        subscription.currentPeriodEnd, subscription.providerEventCreatedAt, subscription.createdAt, subscription.updatedAt],
    );
  }

  async getSubscription(tenantId: string): Promise<SubscriptionRecord | null> {
    const result = await this.#pool.query("SELECT * FROM tenant_subscriptions WHERE tenant_id=$1", [tenantId]);
    const row = result.rows[0] as Row | undefined;
    return row ? {
      tenantId: String(row.tenant_id),
      providerCustomerId: row.provider_customer_id === null ? null : String(row.provider_customer_id),
      providerSubscriptionId: row.provider_subscription_id === null ? null : String(row.provider_subscription_id),
      status: row.status as SubscriptionRecord["status"],
      currentPeriodEnd: row.current_period_end === null ? null : iso(row.current_period_end),
      providerEventCreatedAt: iso(row.provider_event_created_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    } : null;
  }

  async purgeWebhookEvents(before: string): Promise<number> {
    const result = await this.#pool.query("DELETE FROM webhook_events WHERE received_at < $1", [before]);
    return result.rowCount ?? 0;
  }

  private mapCall(row: Row): CallRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      providerCallId: String(row.provider_call_id),
      fromNumber: this.cryptoBox.decrypt(String(row.from_number_ciphertext)) ?? "",
      fromNumberVerified: row.from_number_verified === true,
      startedAt: iso(row.started_at),
      endedAt: row.ended_at ? iso(row.ended_at) : null,
      durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      fields: JSON.parse(this.cryptoBox.decrypt(String(row.fields_ciphertext)) ?? "{}") as CallRecord["fields"],
      emergency: (row.emergency as CallRecord["emergency"]) ?? null,
      outcome: row.outcome as CallRecord["outcome"],
      transcript: this.cryptoBox.decrypt(row.transcript_ciphertext === null ? null : String(row.transcript_ciphertext)),
      recordingUrl: this.cryptoBox.decrypt(row.recording_url_ciphertext === null ? null : String(row.recording_url_ciphertext)),
      consentState: row.consent_state as CallRecord["consentState"],
      billingDisposition: row.billing_disposition as CallRecord["billingDisposition"],
      qualityFlags: Array.isArray(row.quality_flags) ? row.quality_flags.map(String) : [],
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }
}

function mapOwnerAccount(row: Row, cryptoBox: CryptoBox): OwnerAccount {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    email: cryptoBox.decrypt(String(row.email_ciphertext)) ?? "",
    displayName: cryptoBox.decrypt(String(row.display_name_ciphertext)) ?? "",
    passwordHash: String(row.password_hash),
    role: row.role === "owner" ? "owner" : "member",
    status: row.status as OwnerAccount["status"],
    sessionVersion: row.session_version === undefined || row.session_version === null ? 0 : Number(row.session_version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapBooking(row: Row): BookingRecord {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), callId: String(row.call_id),
    requestedStart: row.requested_start ? iso(row.requested_start) : null,
    requestedEnd: row.requested_end ? iso(row.requested_end) : null,
    status: row.status as BookingRecord["status"], providerEventId: row.provider_event_id ? String(row.provider_event_id) : null,
    writeVerifiedAt: row.write_verified_at ? iso(row.write_verified_at) : null,
    confirmationNotificationId: row.confirmation_notification_id ? String(row.confirmation_notification_id) : null,
    verificationFailures: Array.isArray(row.verification_failures) ? row.verification_failures.map(String) : [],
    failureReason: row.failure_reason ? String(row.failure_reason) : null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function mapCallbackTask(row: Row): CallbackTask {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), callId: String(row.call_id), ownerRef: String(row.owner_ref),
    reason: String(row.reason), priority: row.priority as CallbackTask["priority"], status: row.status as CallbackTask["status"],
    dueAt: iso(row.due_at), completedAt: row.completed_at ? iso(row.completed_at) : null,
    completionSource: row.completion_source ? row.completion_source as CallbackTask["completionSource"] : null,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function mapToolEvent(row: Row): ToolEvent {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), callId: String(row.call_id), tool: String(row.tool),
    startedAt: iso(row.started_at), completedAt: iso(row.completed_at), latencyMs: Number(row.latency_ms),
    result: row.result as ToolEvent["result"], metadata: row.metadata as Record<string, unknown>,
    redactedError: row.redacted_error ? String(row.redacted_error) : null,
  };
}

function mapNotification(row: Row, cryptoBox: CryptoBox): OutboxNotification {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), callId: row.call_id ? String(row.call_id) : null,
    channel: row.channel as OutboxNotification["channel"], destinationRef: cryptoBox.decrypt(String(row.destination_ref_ciphertext)) ?? "",
    senderRef: row.sender_ref === "founder" ? "founder" : "default",
    body: cryptoBox.decrypt(String(row.body_ciphertext)) ?? "", priority: row.priority as OutboxNotification["priority"],
    state: row.state as OutboxNotification["state"], attempts: Number(row.attempts), nextAttemptAt: iso(row.next_attempt_at),
    idempotencyKey: String(row.idempotency_key), providerReceipt: row.provider_receipt ? String(row.provider_receipt) : null,
    lastError: row.last_error ? String(row.last_error) : null, createdAt: iso(row.created_at), sentAt: row.sent_at ? iso(row.sent_at) : null,
  };
}

function mapPilotSignup(row: Row, cryptoBox: CryptoBox): PilotSignup {
  return {
    id: String(row.id),
    ownerName: cryptoBox.decrypt(String(row.owner_name_ciphertext)) ?? "",
    businessName: cryptoBox.decrypt(String(row.business_name_ciphertext)) ?? "",
    email: cryptoBox.decrypt(String(row.email_ciphertext)) ?? "",
    phone: cryptoBox.decrypt(String(row.phone_ciphertext)) ?? "",
    website: cryptoBox.decrypt(row.website_ciphertext === null ? null : String(row.website_ciphertext)),
    trade: row.trade as PilotSignup["trade"],
    serviceArea: cryptoBox.decrypt(String(row.service_area_ciphertext)) ?? "",
    desiredMode: row.desired_mode as PilotSignup["desiredMode"],
    missedCallsPerWeek: row.missed_calls_per_week === null ? null : Number(row.missed_calls_per_week),
    calendarProvider: row.calendar_provider as PilotSignup["calendarProvider"],
    notes: cryptoBox.decrypt(row.notes_ciphertext === null ? null : String(row.notes_ciphertext)),
    status: row.status as PilotSignup["status"],
    source: row.source as PilotSignup["source"],
    consentedAt: iso(row.consented_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const LOCK_WAIT_MS = 3_000;

async function acquireAdvisoryLock(client: pg.PoolClient, key: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [key]);
    if (result.rows[0]?.locked === true) return;
    if (Date.now() >= deadline) throw new Error(`Lock wait timed out for ${key.split(":")[0]}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function releaseAdvisoryLock(client: pg.PoolClient, key: string): Promise<void> {
  const result = await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked", [key]);
  if (result.rows[0]?.unlocked !== true) throw new Error("Advisory lock was not held");
}
