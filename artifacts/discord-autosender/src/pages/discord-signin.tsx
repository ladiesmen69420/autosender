import { useEffect, useState } from "react";
import { useSignIn } from "@clerk/react";
import { useLocation } from "wouter";

export default function DiscordSignIn() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const [, setLocation] = useLocation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !signIn) return;

    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");

    if (!token) {
      setLocation("/");
      return;
    }

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
        setError(err?.errors?.[0]?.message ?? "Sign-in failed. Please try again.");
      }
    })();
  }, [isLoaded, signIn, setActive, setLocation]);

  return (
    <div className="min-h-screen bg-[#0d0d0f] flex items-center justify-center">
      {error ? (
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
          <button
            onClick={() => setLocation("/")}
            className="text-blue-400 hover:underline text-sm"
          >
            Back to home
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 border-2 border-[#5865F2] border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">Signing you in with Discord…</p>
        </div>
      )}
    </div>
  );
}
