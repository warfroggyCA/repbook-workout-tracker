import { getDb } from "@/db";
import { getRouteUser } from "@/lib/route-auth";
import { handleHevyStagingRequest } from "@/services/hevy-staging-route";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleHevyStagingRequest(request, {
    getUser: getRouteUser,
    getDb,
  });
}
