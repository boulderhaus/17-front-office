import pg from "pg";
import type { Store } from "../ports.js";
import type { BookingRecord, BusinessConfig, CallbackTask, CallRecord, CustomerRecord, OutboxNotification, ToolEvent } from "../domain/models.js";
import { CryptoBox } from "../security/crypto-box.js";
import { normalizeBusinessConfig } from "../domain/config.js";

const { Pool } = pg;

type Row = Record<string, unknown>;

export class PostgresStore implements Store {
  readonly #pool: pg.Pool;
  readonly #lockPool: pg.Pool;

  constructor(databaseUrl: string, private readonly cryptoBox: CryptoBox) {
    this.#pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
    // Advisory locks must not consume the same pool used by the work inside the
    // critical section. A burst of lock holders would otherwise starve their
    // own queries and deadlock at the pool limit.
    this.#lockPool = new Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000 });
  }

  async close(): Promise<void> {
    await Promise.all([this.#pool.end(), this.#lockPool.end()]);
  }

  async ping(): Promise<void> {
    await this.#pool.query("SELECT 1");
  }

  async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const client = await this.#lockPool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
      return await task();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch(() => undefined);
      client.release();
    }
  }

  async claimWebhook(eventId: string): Promise<boolean> {
    const result = await this.#pool.query(
      "INSERT INTO webhook_events(event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
      [eventId],
    );
    return result.rowCount === 1;
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

  async saveIntegrationSecret(tenantId: string, provider: string, key: string, value: string): Promise<void> {
    await this.#pool.query(
      `INSERT INTO integration_secrets(tenant_id,provider,secret_key,value_ciphertext,updated_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT (tenant_id,provider,secret_key) DO UPDATE SET value_ciphertext=EXCLUDED.value_ciphertext,updated_at=now()`,
      [tenantId, provider, key, this.cryptoBox.encrypt(value)],
    );
  }

  async getCallByProviderId(providerCallId: string): Promise<CallRecord | null> {
    const result = await this.#pool.query("SELECT * FROM calls WHERE provider_call_id = $1", [providerCallId]);
    return result.rows[0] ? this.mapCall(result.rows[0] as Row) : null;
  }

  async getCall(callId: string): Promise<CallRecord | null> {
    const result = await this.#pool.query("SELECT * FROM calls WHERE id = $1", [callId]);
    return result.rows[0] ? this.mapCall(result.rows[0] as Row) : null;
  }

  async saveCall(call: CallRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO calls(
         id, tenant_id, provider_call_id, from_number_hash, from_number_ciphertext, started_at, ended_at,
         duration_seconds, fields_ciphertext, emergency, outcome, transcript_ciphertext,
         recording_url_ciphertext, consent_state, billing_disposition, quality_flags, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (id) DO UPDATE SET
         from_number_hash = EXCLUDED.from_number_hash,
         from_number_ciphertext = EXCLUDED.from_number_ciphertext,
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

  async deleteCall(tenantId: string, callId: string): Promise<boolean> {
    const result = await this.#pool.query("DELETE FROM calls WHERE tenant_id=$1 AND id=$2", [tenantId, callId]);
    return result.rowCount === 1;
  }

  async deleteExpiredCalls(tenantId: string, endedBefore: string): Promise<number> {
    const result = await this.#pool.query(
      "DELETE FROM calls WHERE tenant_id=$1 AND ended_at IS NOT NULL AND ended_at < $2",
      [tenantId, endedBefore],
    );
    return result.rowCount ?? 0;
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

  async saveCallbackTask(task: CallbackTask): Promise<void> {
    await this.#pool.query(
      `INSERT INTO callback_tasks(id,tenant_id,call_id,owner_ref,reason,priority,status,due_at,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (call_id) DO UPDATE SET owner_ref=EXCLUDED.owner_ref,reason=EXCLUDED.reason,priority=EXCLUDED.priority,
         status=EXCLUDED.status,due_at=EXCLUDED.due_at,updated_at=EXCLUDED.updated_at`,
      [task.id, task.tenantId, task.callId, task.ownerRef, task.reason, task.priority, task.status, task.dueAt, task.createdAt, task.updatedAt],
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
      `INSERT INTO notification_outbox(id,tenant_id,call_id,channel,destination_ref_ciphertext,body_ciphertext,priority,state,attempts,next_attempt_at,idempotency_key,provider_receipt,last_error,created_at,sent_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [notification.id, notification.tenantId, notification.callId, notification.channel, this.cryptoBox.encrypt(notification.destinationRef), this.cryptoBox.encrypt(notification.body), notification.priority, notification.state, notification.attempts, notification.nextAttemptAt, notification.idempotencyKey, notification.providerReceipt, notification.lastError, notification.createdAt, notification.sentAt],
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

  async listNotifications(callId: string): Promise<OutboxNotification[]> {
    const result = await this.#pool.query("SELECT * FROM notification_outbox WHERE call_id=$1 ORDER BY created_at", [callId]);
    return result.rows.map((row) => mapNotification(row as Row, this.cryptoBox));
  }

  private mapCall(row: Row): CallRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      providerCallId: String(row.provider_call_id),
      fromNumber: this.cryptoBox.decrypt(String(row.from_number_ciphertext)) ?? "",
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
    dueAt: iso(row.due_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
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
    id: String(row.id), tenantId: String(row.tenant_id), callId: String(row.call_id),
    channel: row.channel as OutboxNotification["channel"], destinationRef: cryptoBox.decrypt(String(row.destination_ref_ciphertext)) ?? "",
    body: cryptoBox.decrypt(String(row.body_ciphertext)) ?? "", priority: row.priority as OutboxNotification["priority"],
    state: row.state as OutboxNotification["state"], attempts: Number(row.attempts), nextAttemptAt: iso(row.next_attempt_at),
    idempotencyKey: String(row.idempotency_key), providerReceipt: row.provider_receipt ? String(row.provider_receipt) : null,
    lastError: row.last_error ? String(row.last_error) : null, createdAt: iso(row.created_at), sentAt: row.sent_at ? iso(row.sent_at) : null,
  };
}
