import { useEffect, useRef, useState } from "react";
import { useSignIn, useAuth } from "@clerk/react";
import { useLocation } from "wouter";

const TIMEOUT_MS = 20_000;

export default function DiscordSignIn() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const { isSignedIn } = useAuth();
  const [, setLocation] = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const attempted = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!attempted.current) {
        setTimedOut(true);
      }
    }, TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (isSignedIn) {
      setLocation("/app");
      return;
    }

    if (!isLoaded || !signIn) return;
    if (attempted.current) return;

    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");

    if (!token) {
      setLocation("/");
      return;
    }

    attempted.current = true;

    (async () => {
      try {
        const result = await signIn.create({ strategy: "ticket", ticket: token });
        if (result.status === "complete" && setActive) {
          await setActive({ session: result.createdSessionId });
          setLocation("/app");
        } else {
          setError("Sign-in could not be completed. Please try again.");
        }
      } catch (err: any) {
        console.error("Token sign-in error:", err);
        const msg =
          err?.errors?.[0]?.longMessage ??
          err?.errors?.[0]?.message ??
          "Sign-in failed. Please try again.";
        setError(msg);
      }
    })();
  }, [isLoaded, isSignedIn, signIn, setActive, setLocation]);

  if (error || timedOut) {
    return (
      <div className="min-h-screen bg-[#0d0d0f] flex items-center justify-center">
        <div className="text-center space-y-3 max-w-sm px-4">
          <p className="text-red-400 text-sm">
            {error ?? "Sign-in timed out — the link may have expired or Clerk is slow to load. Please try again."}
          </p>
          <button
            onClick={() => setLocation("/")}
            className="text-blue-400 hover:underline text-sm"
          >
            Back to home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0d0d0f] flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-6 h-6 border-2 border-[#5865F2] border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-400 text-sm">Signing you in with Discord…</p>
      </div>
    </div>
  );
}
