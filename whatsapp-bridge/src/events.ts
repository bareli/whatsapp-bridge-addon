import { EventEmitter } from "events";

export type BridgeEvent =
  | { type: "state"; payload: Record<string, unknown> }
  | { type: "qr"; payload: { qr: string; generated_at: string } }
  | {
      type: "message";
      payload: {
        id: string;
        from: string;
        to: string;
        body: string;
        timestamp: number;
        has_media: boolean;
        media_mime: string | null;
        ack: number;
      };
    }
  | { type: "ack"; payload: { id: string; ack: number } };

class Bus extends EventEmitter {
  emitEvent(evt: BridgeEvent) {
    this.emit("event", evt);
  }
}

export const bus = new Bus();
bus.setMaxListeners(50);
