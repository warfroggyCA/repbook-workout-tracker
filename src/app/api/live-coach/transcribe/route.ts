import { getRouteUser } from "@/lib/route-auth";
import { getDb } from "@/db";
import { handleLiveCoachTranscriptionRequest } from "@/services/live-coach-transcription-route";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleLiveCoachTranscriptionRequest(request, {
    getUser: getRouteUser,
    getDb,
  });
}
