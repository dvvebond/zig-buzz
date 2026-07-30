import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Network from "expo-network";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { AppState } from "react-native";

import type { Community } from "../domain/models";
import { MobileRelay } from "../services/mobile-relay";
import { activeSecret, useAppStore } from "./app-store";
import { useClientState } from "./client-state";

type RelayContextValue = {
  readonly community: Community;
  readonly relay: MobileRelay;
  readonly secretKey: Uint8Array;
};

const RelayContext = createContext<RelayContextValue | undefined>(undefined);

export function RelayProvider({
  children,
  community,
}: PropsWithChildren<{ readonly community: Community }>) {
  const setConnection = useAppStore((state) => state.setConnection);
  const initializeClientState = useClientState((state) => state.initialize);
  const [value, setValue] = useState<RelayContextValue>();
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 2,
            staleTime: 10_000,
          },
        },
      }),
    [],
  );

  useEffect(() => {
    let active = true;
    let relay: MobileRelay | undefined;
    let secretKey: Uint8Array | undefined;
    let unsubscribeState: (() => void) | undefined;
    let unsubscribeNetwork: (() => void) | undefined;

    void initializeClientState(community);
    void activeSecret(community)
      .then(async (identity) => {
        if (!active) {
          identity.secretKey.fill(0);
          return;
        }
        secretKey = identity.secretKey;
        relay = new MobileRelay({
          relayUrl: community.relayUrl,
          secretKey,
        });
        setValue({ community, relay, secretKey });
        unsubscribeState = relay.onState(setConnection);
        const current = await Network.getNetworkStateAsync().catch(
          () => undefined,
        );
        relay.setOnline(current?.isConnected !== false);
        const networkSubscription = Network.addNetworkStateListener((state) => {
          relay?.setOnline(state.isConnected !== false);
        });
        unsubscribeNetwork = () => networkSubscription.remove();
        await relay.connect().catch(() => undefined);
        if (!active) relay.close();
      })
      .catch((reason: unknown) => {
        if (active) {
          useAppStore.setState({
            error:
              reason instanceof Error
                ? reason.message
                : "relay initialization failed",
          });
        }
      });

    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void relay?.connect().catch(() => undefined);
        void relay
          ?.publish({ content: "online", kind: 20_001, tags: [] })
          .catch(() => undefined);
      } else if (state === "background") {
        void relay
          ?.publish({ content: "away", kind: 20_001, tags: [] })
          .catch(() => undefined);
      }
    });
    const presence = setInterval(() => {
      if (AppState.currentState === "active") {
        void relay
          ?.publish({ content: "online", kind: 20_001, tags: [] })
          .catch(() => undefined);
      }
    }, 60_000);
    return () => {
      active = false;
      appState.remove();
      clearInterval(presence);
      unsubscribeNetwork?.();
      unsubscribeState?.();
      relay?.close();
      secretKey?.fill(0);
      queryClient.clear();
      setValue(undefined);
    };
  }, [community, initializeClientState, queryClient, setConnection]);

  if (!value) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <RelayContext.Provider value={value}>{children}</RelayContext.Provider>
    </QueryClientProvider>
  );
}

export function useRelay(): RelayContextValue {
  const value = useContext(RelayContext);
  if (!value) throw new Error("relay context is unavailable");
  return value;
}
