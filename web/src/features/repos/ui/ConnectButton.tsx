import { ExternalLink } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";

/**
 * How long to wait before deciding the `buzz://` navigation was ignored.
 *
 * A handled deep link hands focus to the desktop app, so this tab goes hidden
 * or loses focus within a few hundred milliseconds. When no application is
 * registered for the scheme the browser discards the navigation with no error
 * of any kind, which is what made this button look dead.
 */
const HANDOFF_GRACE_MS = 1_200;

export function ConnectButton({ className }: { className?: string }) {
  const relayUrl = relayWsUrl();
  const deepLink = `buzz://connect?relay=${encodeURIComponent(relayUrl)}`;
  const timer = React.useRef<number | undefined>(undefined);

  React.useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    },
    [],
  );

  function reportMissingHandler() {
    toast.error("Buzz desktop did not open", {
      action: {
        label: "Copy relay URL",
        onClick: () => {
          void navigator.clipboard
            .writeText(relayUrl)
            .then(() => toast.success("Copied to clipboard"))
            .catch(() => toast.error("Failed to copy to clipboard"));
        },
      },
      description: `Install the Buzz desktop app, or add this community by hand using the relay URL ${relayUrl}`,
      duration: 12_000,
    });
  }

  function handleClick(event: React.MouseEvent<HTMLAnchorElement>) {
    // Drive the navigation here instead of letting the anchor do it, so the
    // handoff can be timed. Modified clicks stay with the browser.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();

    if (timer.current !== undefined) window.clearTimeout(timer.current);
    window.location.href = deepLink;
    timer.current = window.setTimeout(() => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        reportMissingHandler();
      }
    }, HANDOFF_GRACE_MS);
  }

  return (
    <Button
      asChild
      className={`bg-black text-white hover:bg-black/90 focus-visible:ring-black dark:bg-white dark:text-black dark:hover:bg-white/90 dark:focus-visible:ring-white ${className ?? ""}`}
    >
      <a href={deepLink} onClick={handleClick}>
        <ExternalLink className="h-4 w-4" />
        Open in Buzz
      </a>
    </Button>
  );
}
