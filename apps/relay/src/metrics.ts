export class RelayMetrics {
  readonly startedAt = Date.now();
  websocketConnectionsTotal = 0;
  websocketMessagesTotal = 0;
  authenticationTimeoutsTotal = 0;
  eventsPublishedTotal = 0;
  rejectedRequestsTotal = 0;
  httpRequestsTotal = 0;
  admissionWebsocketQuotaRejectionsTotal = 0;
  admissionWebsocketUnavailableRejectionsTotal = 0;
  admissionHttpQuotaRejectionsTotal = 0;
  admissionHttpUnavailableRejectionsTotal = 0;

  public recordAdmissionRejection(
    transport: "http" | "websocket",
    reason: "quota" | "unavailable",
  ): void {
    if (transport === "websocket" && reason === "quota") {
      this.admissionWebsocketQuotaRejectionsTotal += 1;
    } else if (transport === "websocket") {
      this.admissionWebsocketUnavailableRejectionsTotal += 1;
    } else if (reason === "quota") {
      this.admissionHttpQuotaRejectionsTotal += 1;
    } else {
      this.admissionHttpUnavailableRejectionsTotal += 1;
    }
  }

  public render(input: {
    readonly activeConnections: number;
    readonly activeSubscriptions: number;
  }): string {
    const uptime = Math.max(0, (Date.now() - this.startedAt) / 1_000);
    return [
      "# HELP buzz_process_uptime_seconds Relay process uptime.",
      "# TYPE buzz_process_uptime_seconds gauge",
      `buzz_process_uptime_seconds ${uptime.toFixed(3)}`,
      "# HELP buzz_ws_connections_active Active authenticated and unauthenticated WebSockets.",
      "# TYPE buzz_ws_connections_active gauge",
      `buzz_ws_connections_active ${input.activeConnections}`,
      "# HELP buzz_ws_connections_total Accepted WebSocket connections.",
      "# TYPE buzz_ws_connections_total counter",
      `buzz_ws_connections_total ${this.websocketConnectionsTotal}`,
      "# HELP buzz_subscriptions_active Active Nostr subscriptions.",
      "# TYPE buzz_subscriptions_active gauge",
      `buzz_subscriptions_active ${input.activeSubscriptions}`,
      "# HELP buzz_ws_messages_total WebSocket protocol messages received.",
      "# TYPE buzz_ws_messages_total counter",
      `buzz_ws_messages_total ${this.websocketMessagesTotal}`,
      "# HELP buzz_ws_auth_timeouts_total WebSockets closed before NIP-42 authentication.",
      "# TYPE buzz_ws_auth_timeouts_total counter",
      `buzz_ws_auth_timeouts_total ${this.authenticationTimeoutsTotal}`,
      "# HELP buzz_events_published_total Signed events fanned out by this relay process.",
      "# TYPE buzz_events_published_total counter",
      `buzz_events_published_total ${this.eventsPublishedTotal}`,
      "# HELP buzz_rejected_requests_total Rejected HTTP or WebSocket requests.",
      "# TYPE buzz_rejected_requests_total counter",
      `buzz_rejected_requests_total ${this.rejectedRequestsTotal}`,
      "# HELP buzz_http_requests_total HTTP requests received.",
      "# TYPE buzz_http_requests_total counter",
      `buzz_http_requests_total ${this.httpRequestsTotal}`,
      "# HELP buzz_admission_rejections_total Requests rejected by shared admission.",
      "# TYPE buzz_admission_rejections_total counter",
      `buzz_admission_rejections_total{transport="websocket",reason="quota"} ${this.admissionWebsocketQuotaRejectionsTotal}`,
      `buzz_admission_rejections_total{transport="websocket",reason="unavailable"} ${this.admissionWebsocketUnavailableRejectionsTotal}`,
      `buzz_admission_rejections_total{transport="http",reason="quota"} ${this.admissionHttpQuotaRejectionsTotal}`,
      `buzz_admission_rejections_total{transport="http",reason="unavailable"} ${this.admissionHttpUnavailableRejectionsTotal}`,
      "",
    ].join("\n");
  }
}
