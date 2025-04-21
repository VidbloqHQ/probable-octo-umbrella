import { RoomServiceClient } from "livekit-server-sdk";

export const livekitHost = process.env.LIVEKIT_API_HOST as string;
export const roomService = new RoomServiceClient(
  livekitHost,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);