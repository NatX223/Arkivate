"use client";

import type { ReactNode } from "react";
import { HeadProvider } from "@/lib/poll";
import { WalletProvider } from "@/lib/wallet";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WalletProvider>
      <HeadProvider>{children}</HeadProvider>
    </WalletProvider>
  );
}
