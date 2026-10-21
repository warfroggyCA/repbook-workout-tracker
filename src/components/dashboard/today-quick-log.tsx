"use client";

import { useState } from "react";
import { Mic } from "lucide-react";
import { QuickLogCard } from "@/components/quick-log/quick-log-card";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";

export function TodayQuickLog() {
  const [open, setOpen] = useState(false);
  return <>
    <Button type="button" variant="outline" className="one-next-quick-log" onClick={() => setOpen(true)}>
      <Mic aria-hidden="true" /> Speak or type a quick log
    </Button>
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Quick log</DrawerTitle>
          <DrawerDescription>
            Type, or use your keyboard’s dictation. Review before saving.
            This records separate training, not sets in an active workout.
          </DrawerDescription>
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4"><QuickLogCard embedded /></div>
        <DrawerFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Close</Button></DrawerFooter>
      </DrawerContent>
    </Drawer>
  </>;
}
