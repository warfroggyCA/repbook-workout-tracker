import { describe, expect, it } from "vitest";
import { equipmentAttentionIds, equipmentManagementHref, equipmentReturnHref } from "@/lib/equipment-management-navigation";
const owned = "10000000-0000-4000-8000-000000000001";
const other = "20000000-0000-4000-8000-000000000002";
describe("equipment repair navigation", () => {
  it("carries exact item and a validated workout return route", () => {
    const url = new URL(equipmentManagementHref({ itemIds: [owned, owned], returnTo: `/session/${other}` }), "https://example.com");
    expect(url.searchParams.getAll("item")).toEqual([owned]);
    expect(url.searchParams.get("returnTo")).toBe(`/session/${other}`);
    expect(equipmentReturnHref("//example.com")).toBeUndefined();
    expect(equipmentReturnHref("/session/invalid")).toBeUndefined();
  });
  it("never opens an unowned item or substitutes a type when an exact item was requested", () => {
    const items = [{ id: owned, type: "cable" as const }];
    expect(equipmentAttentionIds(items, { item: other, type: "cable" })).toEqual([]);
    expect(equipmentAttentionIds(items, { type: "cable" })).toEqual([owned]);
    expect(equipmentAttentionIds(items, { item: owned })).toEqual([owned]);
    expect(equipmentManagementHref({ itemIds: ["invalid"], returnTo: "https://example.com" })).toBe("/settings/equipment");
  });
  it("routes a definition only to its owned item without falling back to a similar machine", () => {
    const definition = "30000000-0000-4000-8000-000000000003";
    const items = [{ id: owned, type: "cable" as const }];
    const definitions = [{ itemId: owned, definitionId: definition }];
    expect(equipmentAttentionIds(items, { definition, type: "cable" }, definitions)).toEqual([owned]);
    expect(equipmentAttentionIds(items, { definition: other, type: "cable" }, definitions)).toEqual([]);
    const url = new URL(equipmentManagementHref({ equipmentDefinitionId: definition }), "https://example.com");
    expect(url.searchParams.get("definition")).toBe(definition);
  });
});
