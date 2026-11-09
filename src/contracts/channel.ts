export type ChannelRoute = {
  adapter: string;
  routeId: string;
  epochId: string;
  revision: number;
  humanId: string;
  projectId: string;
  chatId: string;
  destination: Readonly<Record<string, string>>;
};

export type ChannelEnvelope =
  | { kind: "text"; text: string; completeness: "complete" | "incomplete" | "oversized" }
  | {
      kind: "card";
      text: string;
      actions: { label: string; token: string }[];
    };

export type ChannelOutcome =
  | { kind: "accepted"; messageId: string }
  | { kind: "not_accepted"; code: "rate_limited" | "unavailable" | "invalid_payload" }
  | { kind: "uncertain"; code: "timeout" | "ack_lost" | "ambiguous" };

export type ChannelRequest = {
  deliveryId: string;
  uuid: string;
  route: ChannelRoute;
  envelope: ChannelEnvelope;
};

// The adapter must hand the request to its I/O primitive inside begin, before returning.
export interface ChannelEmissionPort<Prepared> {
  prepare(request: ChannelRequest): Promise<Prepared>;
  begin(prepared: Prepared): {
    initiated: true;
    completion: Promise<ChannelOutcome>;
  };
}

export interface ChannelRouteBoundary {
  adapter: string;
  assertCurrent(route: ChannelRoute): void;
}

export type ChannelActionResult =
  | { kind: "proposal"; status: string; workMessageId: string | null }
  | { kind: "watch"; active: true; watchId: string }
  | { kind: "watch"; rejected: true };

export type ChannelNativeAction =
  | { kind: "proposal"; proposalId: string; operationHash: string; action: "confirm" | "reject" }
  | { kind: "watch"; eventId: string; factHash: string; action: "confirm" | "reject" };
