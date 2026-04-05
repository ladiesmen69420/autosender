import React, { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useValidateToken,
  useGenerateAIReply,
  useRunAutoReply,
  useFetchDMs,
} from "@workspace/api-client-react";
import type { TokenValidationResult, DMConversation } from "@workspace/api-client-react/src/generated/api.schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import {
  LayoutDashboard, Zap, Key, Bot, History, ChevronRight,
  Play, Square, Save, Trash2, RefreshCw, Plus,
  Activity, Clock, TrendingUp, MessageSquare,
  Cpu, Radio, AlertTriangle, CheckCircle, XCircle, Loader2,
  ChevronDown, ChevronUp, Shield, Gauge, RotateCcw,
} from "lucide-react";
import logoUrl from "/logo.png";

type View = "dashboard" | "autosender" | "ai-reply" | "tokens" | "logs";

type ServerCampaign = {
  id: number;
  name: string;
  token: string;
  channels: string[];
  message: string;
  delay: number;
  jitter: number;
  running: boolean;
  sentCount: number;
  failedCount: number;
  rateLimitBonus: number;
  lastSentAt: string | null;
  createdAt: string;
};

type LogEntry = {
  id: string;
  timestamp: Date;
  message: string;
  type: "info" | "success" | "error";
  view?: View;
};

const API = `${import.meta.env.BASE_URL}api`;

function useGetCampaigns() {
  return useQuery<ServerCampaign[]>({
    queryKey: ["campaigns"],
    queryFn: async () => {
      const res = await fetch(`${API}/campaigns`);
      if (!res.ok) throw new Error("Failed to fetch campaigns");
      return res.json();
    },
    refetchInterval: 2500,
  });
}

function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Omit<ServerCampaign, "id" | "running" | "sentCount" | "failedCount" | "rateLimitBonus" | "lastSentAt" | "createdAt">) => {
      const res = await fetch(`${API}/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create campaign");
      return res.json() as Promise<ServerCampaign>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

function useUpdateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: Partial<ServerCampaign> & { id: number }) => {
      const res = await fetch(`${API}/campaigns/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update campaign");
      return res.json() as Promise<ServerCampaign>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

function useDeleteCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/campaigns/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete campaign");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

function useStartCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/campaigns/${id}/start`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to start campaign");
      return res.json() as Promise<ServerCampaign>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

function useStopCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/campaigns/${id}/stop`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to stop campaign");
      return res.json() as Promise<ServerCampaign>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

function useResetStats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/campaigns/${id}/reset-stats`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to reset stats");
      return res.json() as Promise<ServerCampaign>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

function useLocalState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }, [key, value]);
  return [value, setValue] as const;
}

export default function Home() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const validateTokenMutation = useValidateToken();
  const generateAIReplyMutation = useGenerateAIReply();
  const runAutoReplyMutation = useRunAutoReply();
  const fetchDMsMutation = useFetchDMs();

  const { data: campaigns = [], isLoading: campaignsLoading } = useGetCampaigns();
  const createCampaign = useCreateCampaign();
  const updateCampaign = useUpdateCampaign();
  const deleteCampaign = useDeleteCampaign();
  const startCampaign = useStartCampaign();
  const stopCampaign = useStopCampaign();
  const resetStats = useResetStats();

  const [activeView, setActiveView] = useLocalState<View>("bb_view", "dashboard");

  // Draft state for creating/editing campaigns (not persisted server-side until saved)
  const [drafts, setDrafts] = useLocalState<Record<number | string, {
    name: string; token: string; channelsInput: string; message: string; delay: number; jitter: number; expanded: boolean; tokenValid: boolean | null;
  }>>("bb_drafts", {});

  const newCampaignDraft = {
    name: "", token: "", channelsInput: "", message: "", delay: 15, jitter: 0, expanded: true, tokenValid: null,
  };

  // Token page
  const [tokenInput, setTokenInput] = useLocalState("bb_token_input", "");
  const [tokenInfo, setTokenInfo] = useState<TokenValidationResult | null>(null);

  // AI Reply
  const [aiToken, setAiToken] = useLocalState("bb_ai_token", "");
  const [aiPersona, setAiPersona] = useLocalState("bb_ai_persona", "");
  const [aiContext, setAiContext] = useState("");
  const [aiChannelId, setAiChannelId] = useState("");
  const [generatedReply, setGeneratedReply] = useState("");
  const [dms, setDMs] = useState<DMConversation[]>([]);
  const [autoReplyEnabled, setAutoReplyEnabled] = useLocalState("bb_auto_reply", false);
  const autoReplyRef = useRef(autoReplyEnabled);
  autoReplyRef.current = autoReplyEnabled;

  // Logs
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // New campaign form state (inline, not persisted until created)
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState({ name: "Campaign 1", token: "", channelsInput: "", message: "", delay: 15, jitter: 0 });

  const addLog = useCallback((msg: string, type: "info" | "success" | "error", view?: View) => {
    setLogs((p) => [{ id: Math.random().toString(36).slice(2), timestamp: new Date(), message: msg, type, view }, ...p].slice(0, 500));
  }, []);

  function getDraft(id: number) {
    return drafts[id] ?? null;
  }

  function setDraft(id: number, updates: Partial<typeof newCampaignDraft>) {
    setDrafts((p) => ({ ...p, [id]: { ...(p[id] ?? { name: "", token: "", channelsInput: "", message: "", delay: 15, jitter: 0, expanded: true, tokenValid: null }), ...updates } }));
  }

  function initDraft(campaign: ServerCampaign) {
    if (!drafts[campaign.id]) {
      setDraft(campaign.id, {
        name: campaign.name,
        token: campaign.token,
        channelsInput: campaign.channels.join("\n"),
        message: campaign.message,
        delay: campaign.delay,
        jitter: campaign.jitter,
        expanded: true,
        tokenValid: null,
      });
    }
  }

  // Initialize drafts for campaigns that don't have one
  useEffect(() => {
    campaigns.forEach((c) => initDraft(c));
  }, [campaigns.map((c) => c.id).join(",")]);

  // Auto-reply loop
  useEffect(() => {
    if (!autoReplyEnabled || !aiToken) return;
    const run = async () => {
      if (!autoReplyRef.current) return;
      addLog("Auto-reply scan running...", "info", "ai-reply");
      try {
        const res = await runAutoReplyMutation.mutateAsync({ data: { token: aiToken, persona: aiPersona || undefined } });
        if (res.replied > 0) addLog(`Auto-replied to ${res.replied} DM(s), skipped ${res.skipped}.`, "success", "ai-reply");
        else addLog(`Scan complete: ${res.skipped} DM(s) already replied or empty.`, "info", "ai-reply");
      } catch { addLog("Auto-reply scan failed.", "error", "ai-reply"); }
    };
    run();
    const id = setInterval(run, 60000);
    return () => clearInterval(id);
  }, [autoReplyEnabled, aiToken]);

  // Token validation (Tokens page)
  const handleValidateToken = async () => {
    if (!tokenInput) return;
    try {
      const result = await validateTokenMutation.mutateAsync({ data: { token: tokenInput } });
      setTokenInfo(result);
      if (result.valid) {
        addLog(`Token valid: ${result.username}#${result.discriminator}`, "success", "tokens");
        toast({ title: "Token Valid", description: `Authenticated as ${result.username}` });
      } else {
        addLog(`Token rejected: ${result.error}`, "error", "tokens");
        toast({ title: "Invalid Token", description: result.error || "Rejected", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Validation failed.", variant: "destructive" });
    }
  };

  const handleValidateCampaignToken = async (id: number, token: string) => {
    if (!token) return;
    try {
      const result = await validateTokenMutation.mutateAsync({ data: { token } });
      setDraft(id, { tokenValid: result.valid ?? false });
      if (result.valid) toast({ title: "Valid", description: `${result.username}#${result.discriminator}` });
      else toast({ title: "Invalid Token", description: result.error || "Rejected", variant: "destructive" });
    } catch { setDraft(id, { tokenValid: false }); }
  };

  const handleCreateCampaign = async () => {
    if (!newForm.name || !newForm.token || !newForm.channelsInput || !newForm.message) {
      toast({ title: "Missing fields", description: "Name, token, channels, and message are required.", variant: "destructive" });
      return;
    }
    const channels = newForm.channelsInput.split(/[\n,]+/).map((c) => c.trim()).filter(Boolean);
    try {
      const created = await createCampaign.mutateAsync({ name: newForm.name, token: newForm.token, channels, message: newForm.message, delay: newForm.delay, jitter: newForm.jitter });
      setDraft(created.id, { name: newForm.name, token: newForm.token, channelsInput: newForm.channelsInput, message: newForm.message, delay: newForm.delay, jitter: newForm.jitter, expanded: true, tokenValid: null });
      setShowNewForm(false);
      setNewForm({ name: `Campaign ${campaigns.length + 2}`, token: "", channelsInput: "", message: "", delay: 15, jitter: 0 });
      addLog(`Campaign "${created.name}" created.`, "success", "autosender");
      toast({ title: "Campaign Created", description: created.name });
    } catch {
      toast({ title: "Error", description: "Failed to create campaign.", variant: "destructive" });
    }
  };

  const handleSaveCampaign = async (id: number) => {
    const draft = getDraft(id);
    if (!draft) return;
    const channels = draft.channelsInput.split(/[\n,]+/).map((c) => c.trim()).filter(Boolean);
    try {
      await updateCampaign.mutateAsync({ id, name: draft.name, token: draft.token, channels, message: draft.message, delay: draft.delay, jitter: draft.jitter });
      addLog(`Campaign updated.`, "success", "autosender");
      toast({ title: "Saved" });
    } catch {
      toast({ title: "Error", description: "Failed to save.", variant: "destructive" });
    }
  };

  const handleStart = async (id: number) => {
    const draft = getDraft(id);
    // Auto-save first
    if (draft) {
      const channels = draft.channelsInput.split(/[\n,]+/).map((c) => c.trim()).filter(Boolean);
      await updateCampaign.mutateAsync({ id, name: draft.name, token: draft.token, channels, message: draft.message, delay: draft.delay, jitter: draft.jitter }).catch(() => {});
    }
    try {
      await startCampaign.mutateAsync(id);
      addLog(`Campaign started (server-side — runs even when offline).`, "success", "autosender");
    } catch { toast({ title: "Error", description: "Failed to start.", variant: "destructive" }); }
  };

  const handleStop = async (id: number) => {
    try {
      await stopCampaign.mutateAsync(id);
      addLog(`Campaign stopped.`, "info", "autosender");
    } catch { toast({ title: "Error", description: "Failed to stop.", variant: "destructive" }); }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteCampaign.mutateAsync(id);
      setDrafts((p) => { const copy = { ...p }; delete copy[id]; return copy; });
      addLog("Campaign deleted.", "info");
    } catch { toast({ title: "Error", description: "Failed to delete.", variant: "destructive" }); }
  };

  const handleFetchDMs = async () => {
    if (!aiToken) { toast({ title: "No token", description: "Enter a token in the Token field above.", variant: "destructive" }); return; }
    try {
      const result = await fetchDMsMutation.mutateAsync({ data: { token: aiToken } });
      setDMs(result);
      addLog(`Fetched ${result.length} DM(s).`, "success", "ai-reply");
    } catch {
      addLog("Failed to fetch DMs.", "error", "ai-reply");
      toast({ title: "Error", description: "Could not fetch DMs. Check your token.", variant: "destructive" });
    }
  };

  const handleGenerateAIReply = async (contextOverride?: string, channelOverride?: string) => {
    const ctx = contextOverride ?? aiContext;
    if (!ctx) { toast({ title: "No context", description: "Enter a message to reply to.", variant: "destructive" }); return; }
    try {
      const res = await generateAIReplyMutation.mutateAsync({
        data: { context: ctx, persona: aiPersona || undefined, token: channelOverride ? aiToken : undefined, channelId: channelOverride },
      });
      setGeneratedReply(res.reply);
      addLog(`AI reply generated${res.sent ? " and sent" : ""}.`, "success", "ai-reply");
      if (res.sent) toast({ title: "Reply Sent", description: "AI reply delivered to Discord." });
      else toast({ title: "Reply Generated", description: "Set a Channel ID to auto-send." });
    } catch {
      addLog("AI reply failed.", "error", "ai-reply");
      toast({ title: "Error", description: "Failed to generate reply. Check your AI token and context.", variant: "destructive" });
    }
  };

  const runningCount = campaigns.filter((c) => c.running).length;
  const totalSent = campaigns.reduce((s, c) => s + c.sentCount, 0);
  const totalFailed = campaigns.reduce((s, c) => s + c.failedCount, 0);
  const successRate = totalSent + totalFailed > 0 ? ((totalSent / (totalSent + totalFailed)) * 100).toFixed(1) : "100.0";

  const navItems: { id: View; icon: React.ReactNode; label: string }[] = [
    { id: "dashboard", icon: <LayoutDashboard className="w-4 h-4" />, label: "Dashboard" },
    { id: "autosender", icon: <Radio className="w-4 h-4" />, label: "AutoSender" },
    { id: "ai-reply", icon: <Bot className="w-4 h-4" />, label: "AI Reply" },
    { id: "tokens", icon: <Key className="w-4 h-4" />, label: "Tokens" },
    { id: "logs", icon: <History className="w-4 h-4" />, label: "Logs" },
  ];

  return (
    <div className="h-screen flex bg-background text-foreground overflow-hidden">
      <aside className="w-52 bg-sidebar border-r border-sidebar-border flex flex-col shrink-0">
        <div className="px-4 py-4 border-b border-sidebar-border">
          <div className="flex items-center gap-2.5">
            <img src={logoUrl} alt="logo" className="w-8 h-8 rounded-lg shrink-0 object-cover" />
            <div>
              <div className="font-bold text-sm text-foreground leading-tight">ballistiballs adv</div>
              <div className="text-[9px] text-muted-foreground font-mono uppercase tracking-widest">autosender</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveView(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded text-sm font-medium transition-all duration-150 group ${
                activeView === item.id
                  ? "bg-primary/15 text-primary border border-primary/20"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
              }`}
            >
              <span className={activeView === item.id ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}>
                {item.icon}
              </span>
              {item.label}
              {item.id === "autosender" && runningCount > 0 && (
                <span className="ml-auto text-[10px] bg-green-500/20 text-green-400 border border-green-500/30 rounded px-1.5 py-0.5 font-mono">{runningCount}</span>
              )}
              {activeView === item.id && runningCount === 0 && <ChevronRight className="w-3 h-3 ml-auto text-primary" />}
            </button>
          ))}
        </nav>

        <div className="px-4 py-3 border-t border-sidebar-border space-y-1">
          <div className="flex items-center gap-2">
            <div className={`w-1.5 h-1.5 rounded-full ${runningCount > 0 ? "bg-green-400 animate-pulse" : "bg-muted-foreground/40"}`} />
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
              {runningCount > 0 ? `${runningCount} live (server)` : "Idle"}
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground/60 font-mono">{campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""}</div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="border-b border-border bg-card/40 px-6 py-3.5 flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-base font-semibold text-foreground capitalize">
              {activeView === "ai-reply" ? "AI Reply" : activeView}
            </h1>
            <p className="text-xs text-muted-foreground">
              {activeView === "dashboard" && "Discord automation command center"}
              {activeView === "autosender" && `Server-side scheduling — ${runningCount} active, runs even when offline`}
              {activeView === "ai-reply" && "Generate and send context-aware DM replies with AI"}
              {activeView === "tokens" && "Validate and manage Discord user tokens"}
              {activeView === "logs" && "Real-time activity and event log"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {runningCount > 0 && (
              <Badge className="bg-green-500/10 text-green-400 border-green-500/20 font-mono text-[10px] animate-pulse">
                {runningCount} LIVE
              </Badge>
            )}
            <Badge variant="outline" className="font-mono text-[10px] border-border text-muted-foreground">
              {logs.length} messages
            </Badge>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6">

          {/* DASHBOARD */}
          {activeView === "dashboard" && (
            <div className="space-y-5 max-w-5xl">
              <div className="flex items-start gap-3 p-3 rounded border border-amber-500/20 bg-amber-500/5 text-amber-400/90">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <p className="text-xs leading-relaxed">
                  Self-botting via user tokens violates Discord's Terms of Service and may result in account termination. Use at your own risk.
                </p>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                {[
                  { label: "Campaigns", value: campaigns.length, icon: <Radio className="w-4 h-4" />, sub: `${runningCount} running`, color: "text-primary" },
                  { label: "Running", value: runningCount, icon: <Activity className="w-4 h-4" />, sub: "Server-side", color: runningCount > 0 ? "text-green-400" : "text-muted-foreground" },
                  { label: "Channels", value: campaigns.reduce((s, c) => s + c.channels.length, 0), icon: <MessageSquare className="w-4 h-4" />, sub: "All campaigns", color: "text-violet-300" },
                  { label: "Messages Sent", value: totalSent, icon: <CheckCircle className="w-4 h-4" />, sub: "All time", color: "text-green-400" },
                  { label: "Success Rate", value: `${successRate}%`, icon: <TrendingUp className="w-4 h-4" />, sub: totalSent + totalFailed > 0 ? "Combined" : "No data", color: totalFailed === 0 ? "text-green-400" : "text-amber-400" },
                ].map((stat) => (
                  <div key={stat.label} className="stat-card p-4 rounded border border-border bg-card/60">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{stat.label}</span>
                      <span className={stat.color}>{stat.icon}</span>
                    </div>
                    <div className={`text-2xl font-bold font-mono ${stat.color}`}>{stat.value}</div>
                    <div className="text-[10px] text-muted-foreground mt-1">{stat.sub}</div>
                  </div>
                ))}
              </div>

              {/* Feature pills */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                {[
                  { icon: <Shield className="w-3.5 h-3.5" />, label: "Anti-Detection", desc: "UA rotation + human delays + burst breaks", color: "text-cyan-400 border-cyan-400/20 bg-cyan-400/5" },
                  { icon: <Gauge className="w-3.5 h-3.5" />, label: "Adaptive Rate Limit", desc: "Auto-increases interval on 429 errors", color: "text-amber-400 border-amber-400/20 bg-amber-400/5" },
                  { icon: <Activity className="w-3.5 h-3.5" />, label: "Offline Sending", desc: "Server-side — runs 24/7 even when you close the tab", color: "text-green-400 border-green-400/20 bg-green-400/5" },
                ].map((f) => (
                  <div key={f.label} className={`flex items-start gap-3 p-3 rounded border text-xs ${f.color}`}>
                    <span className="mt-0.5 shrink-0">{f.icon}</span>
                    <div>
                      <div className="font-semibold mb-0.5">{f.label}</div>
                      <div className="opacity-80">{f.desc}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Campaign status */}
              <div className="rounded border border-border bg-card/60 p-4">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
                  <Radio className="w-3.5 h-3.5 text-primary" /> Campaign Status
                </h3>
                {campaigns.length === 0 ? (
                  <div className="text-center py-6 text-muted-foreground text-xs font-mono">
                    No campaigns yet. Go to AutoSender to create one.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {campaigns.map((c) => (
                      <div key={c.id} className="flex items-center gap-3 px-3 py-2 rounded border border-border bg-background/30">
                        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.running ? "bg-green-400 animate-pulse" : "bg-muted-foreground/40"}`} />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium truncate">{c.name}</div>
                          <div className="text-[10px] text-muted-foreground font-mono">
                            {c.channels.length} ch · {c.delay + c.rateLimitBonus}s interval{c.rateLimitBonus > 0 && ` (+${c.rateLimitBonus}s RL)`}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 shrink-0 text-right">
                          <div>
                            <div className="text-xs font-mono text-green-400">{c.sentCount}</div>
                            <div className="text-[9px] text-muted-foreground">sent</div>
                          </div>
                          {c.failedCount > 0 && (
                            <div>
                              <div className="text-xs font-mono text-red-400">{c.failedCount}</div>
                              <div className="text-[9px] text-muted-foreground">fail</div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* AUTOSENDER */}
          {activeView === "autosender" && (
            <div className="max-w-4xl space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className="bg-green-500/10 text-green-400 border-green-500/20 text-[10px] gap-1">
                    <Activity className="w-2.5 h-2.5" />Server-side — stays running 24/7
                  </Badge>
                  <Badge className="bg-cyan-500/10 text-cyan-400 border-cyan-500/20 text-[10px] gap-1">
                    <Shield className="w-2.5 h-2.5" />Anti-detection active
                  </Badge>
                  <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-[10px] gap-1">
                    <Gauge className="w-2.5 h-2.5" />Rate limit protection
                  </Badge>
                </div>
                <Button
                  size="sm"
                  className="h-8 bg-primary/80 hover:bg-primary text-white gap-1.5"
                  onClick={() => setShowNewForm(!showNewForm)}
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Campaign
                </Button>
              </div>

              {/* New campaign form */}
              {showNewForm && (
                <div className="rounded border border-primary/30 bg-primary/5 p-4 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-primary">New Campaign</h3>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    <div>
                      <Label className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 block">Name</Label>
                      <Input value={newForm.name} onChange={(e) => setNewForm((p) => ({ ...p, name: e.target.value }))} className="h-8 text-sm bg-input border-border" placeholder="Campaign name..." />
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 block">Token</Label>
                      <Input type="password" value={newForm.token} onChange={(e) => setNewForm((p) => ({ ...p, token: e.target.value }))} className="h-8 font-mono text-xs bg-input border-border" placeholder="Discord user token..." />
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 block">Channel IDs</Label>
                      <Textarea value={newForm.channelsInput} onChange={(e) => setNewForm((p) => ({ ...p, channelsInput: e.target.value }))} className="min-h-[60px] font-mono text-xs resize-y bg-input border-border" placeholder="One per line or comma separated..." />
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 block">Message</Label>
                      <Textarea value={newForm.message} onChange={(e) => setNewForm((p) => ({ ...p, message: e.target.value }))} className="min-h-[60px] text-sm resize-y bg-input border-border" placeholder="Message to send..." />
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 flex items-center gap-1"><Clock className="w-3 h-3" />Interval (s)</Label>
                      <Input type="number" min="1" value={newForm.delay} onChange={(e) => setNewForm((p) => ({ ...p, delay: Math.max(1, Number(e.target.value)) }))} className="h-8 font-mono bg-input border-border" />
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 flex items-center justify-between"><span>Jitter</span><span className="text-primary">{newForm.jitter}%</span></Label>
                      <Slider min={0} max={100} step={5} value={[newForm.jitter]} onValueChange={([v]) => setNewForm((p) => ({ ...p, jitter: v }))} className="mt-2" />
                    </div>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" className="bg-primary/80 hover:bg-primary" onClick={handleCreateCampaign} disabled={createCampaign.isPending}>
                      {createCampaign.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Plus className="w-3.5 h-3.5 mr-1" />Create</>}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setShowNewForm(false)}>Cancel</Button>
                  </div>
                </div>
              )}

              {campaignsLoading && (
                <div className="text-center py-8 text-muted-foreground text-xs font-mono">Loading campaigns...</div>
              )}

              {!campaignsLoading && campaigns.length === 0 && !showNewForm && (
                <div className="text-center py-16 text-muted-foreground text-sm border border-dashed border-border/50 rounded">
                  No campaigns yet. Click "Add Campaign" to create one.
                </div>
              )}

              {campaigns.map((campaign) => {
                const draft = getDraft(campaign.id);
                const displayDelay = campaign.delay + campaign.rateLimitBonus;

                return (
                  <div key={campaign.id} className={`rounded border bg-card/60 transition-colors ${campaign.running ? "border-primary/30 shadow-[0_0_16px_rgba(124,58,237,0.08)]" : "border-border"}`}>
                    {/* Header */}
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${campaign.running ? "bg-green-400 animate-pulse" : "bg-muted-foreground/30"}`} />

                      <div className="flex-1 font-semibold text-sm truncate">{campaign.name}</div>

                      {campaign.rateLimitBonus > 0 && (
                        <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-[9px] font-mono shrink-0">
                          +{campaign.rateLimitBonus}s RL
                        </Badge>
                      )}

                      {(campaign.sentCount > 0 || campaign.failedCount > 0) && (
                        <div className="flex items-center gap-2 text-[11px] font-mono shrink-0">
                          <span className="text-green-400">{campaign.sentCount} sent</span>
                          {campaign.failedCount > 0 && <span className="text-red-400">{campaign.failedCount} fail</span>}
                        </div>
                      )}

                      <div className="flex items-center gap-1 shrink-0">
                        <Button size="sm" className={`h-7 px-3 text-xs font-bold ${campaign.running ? "bg-red-600/80 hover:bg-red-600 text-white" : "bg-primary/80 hover:bg-primary text-white"}`}
                          onClick={() => campaign.running ? handleStop(campaign.id) : handleStart(campaign.id)}
                          disabled={startCampaign.isPending || stopCampaign.isPending}>
                          {campaign.running ? <><Square className="w-3 h-3 mr-1 fill-current" />Stop</> : <><Play className="w-3 h-3 mr-1 fill-current" />Start</>}
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-primary" title="Reset stats" onClick={() => resetStats.mutate(campaign.id)}>
                          <RotateCcw className="w-3 h-3" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" onClick={() => setDraft(campaign.id, { expanded: !(draft?.expanded ?? true) })}>
                          {(draft?.expanded ?? true) ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-red-400" onClick={() => handleDelete(campaign.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>

                    {/* Body */}
                    {(draft?.expanded ?? true) && draft && (
                      <div className="px-4 pb-4 border-t border-border/50 grid grid-cols-1 lg:grid-cols-2 gap-4 pt-4">
                        <div className="space-y-3">
                          <div>
                            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center justify-between">
                              Name
                            </Label>
                            <Input value={draft.name} onChange={(e) => setDraft(campaign.id, { name: e.target.value })} className="h-8 text-sm bg-input border-border" disabled={campaign.running} />
                          </div>
                          <div>
                            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center justify-between">
                              Token
                              {draft.tokenValid === true && <span className="text-green-400 flex items-center gap-1 text-[9px]"><CheckCircle className="w-3 h-3" />Valid</span>}
                              {draft.tokenValid === false && <span className="text-red-400 flex items-center gap-1 text-[9px]"><XCircle className="w-3 h-3" />Invalid</span>}
                            </Label>
                            <div className="flex gap-1.5">
                              <Input type="password" value={draft.token} onChange={(e) => setDraft(campaign.id, { token: e.target.value, tokenValid: null })} className="h-8 font-mono text-xs bg-input border-border flex-1" disabled={campaign.running} placeholder="Discord user token..." />
                              <Button size="sm" variant="outline" className="h-8 px-2 text-xs border-border shrink-0" onClick={() => handleValidateCampaignToken(campaign.id, draft.token)} disabled={!draft.token || campaign.running || validateTokenMutation.isPending}>
                                Check
                              </Button>
                            </div>
                          </div>
                          <div>
                            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center justify-between">
                              Channel IDs
                              <span className="text-primary font-mono text-[9px]">{draft.channelsInput.split(/[\n,]+/).filter(Boolean).length} ch</span>
                            </Label>
                            <Textarea value={draft.channelsInput} onChange={(e) => setDraft(campaign.id, { channelsInput: e.target.value })} className="min-h-[72px] font-mono text-xs resize-y bg-input border-border" disabled={campaign.running} placeholder="One per line or comma separated..." />
                          </div>
                          <div>
                            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 block">Message</Label>
                            <Textarea value={draft.message} onChange={(e) => setDraft(campaign.id, { message: e.target.value })} className="min-h-[72px] text-sm resize-y bg-input border-border" disabled={campaign.running} placeholder="Message to send..." />
                          </div>
                        </div>

                        <div className="space-y-3">
                          <div className="rounded border border-border bg-background/30 p-3 space-y-3">
                            <div>
                              <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1.5">
                                <Clock className="w-3 h-3" />Interval (s)
                                {campaign.rateLimitBonus > 0 && <span className="text-amber-400 text-[9px]">({displayDelay}s effective w/ RL bonus)</span>}
                              </Label>
                              <Input type="number" min="1" value={draft.delay} onChange={(e) => setDraft(campaign.id, { delay: Math.max(1, Number(e.target.value)) })} className="h-8 font-mono bg-input border-border" disabled={campaign.running} />
                            </div>
                            <div>
                              <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center justify-between">
                                <span>Jitter (random delay %)</span>
                                <span className="text-primary font-mono">{draft.jitter}%</span>
                              </Label>
                              <Slider min={0} max={100} step={5} value={[draft.jitter]} onValueChange={([v]) => setDraft(campaign.id, { jitter: v })} disabled={campaign.running} />
                            </div>
                          </div>

                          {/* Anti-detection info */}
                          <div className="rounded border border-cyan-500/20 bg-cyan-500/5 p-3 space-y-1.5 text-[10px] text-cyan-400/80">
                            <div className="font-semibold text-cyan-400 flex items-center gap-1.5 mb-1"><Shield className="w-3 h-3" />Anti-Detection Active</div>
                            <div>✓ Random User-Agent per request</div>
                            <div>✓ Human-like delays between channels (0.6–2.5s)</div>
                            <div>✓ Burst break every 15 cycles (+30–90s pause)</div>
                          </div>

                          {campaign.rateLimitBonus > 0 && (
                            <div className="rounded border border-amber-500/20 bg-amber-500/5 p-3 text-[10px] text-amber-400/80">
                              <div className="font-semibold text-amber-400 flex items-center gap-1.5 mb-1"><Gauge className="w-3 h-3" />Rate Limit Protection</div>
                              <div>Interval extended by +{campaign.rateLimitBonus}s due to 429 errors.</div>
                              <div className="mt-0.5">Will slowly reduce as sends succeed.</div>
                            </div>
                          )}

                          {!campaign.running && (
                            <Button size="sm" variant="outline" className="w-full h-8 text-xs border-border hover:border-primary/40"
                              onClick={() => handleSaveCampaign(campaign.id)} disabled={updateCampaign.isPending}>
                              <Save className="w-3 h-3 mr-1.5" />Save Changes
                            </Button>
                          )}

                          {campaign.lastSentAt && (
                            <div className="text-[10px] text-muted-foreground font-mono text-center">
                              Last sent: {new Date(campaign.lastSentAt).toLocaleTimeString()}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* AI REPLY */}
          {activeView === "ai-reply" && (
            <div className="max-w-5xl space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="rounded border border-border bg-card/60 p-4 space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    <Key className="w-3.5 h-3.5 text-primary" /> Token & Persona
                  </h3>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest">Discord Token (for DMs)</Label>
                    <Input type="password" placeholder="Enter token to fetch DMs and auto-reply..." value={aiToken} onChange={(e) => setAiToken(e.target.value)} className="font-mono text-sm bg-input border-border" />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest">
                      <span className="flex items-center gap-1.5"><Cpu className="w-3 h-3 text-primary" />AI Persona (optional)</span>
                    </Label>
                    <Textarea placeholder="e.g. You are a friendly gamer. Keep replies casual and short..." value={aiPersona} onChange={(e) => setAiPersona(e.target.value)} className="min-h-[80px] text-sm resize-y bg-input border-border" />
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <div>
                      <Label className="text-sm font-medium cursor-pointer">Auto-Reply</Label>
                      <p className="text-[10px] text-muted-foreground">Scan and reply to DMs every 60s</p>
                    </div>
                    <Switch checked={autoReplyEnabled} onCheckedChange={(v) => {
                      if (v && !aiToken) { toast({ title: "No token", description: "Enter a Discord token above.", variant: "destructive" }); return; }
                      setAutoReplyEnabled(v);
                      addLog(v ? "Auto-reply enabled." : "Auto-reply disabled.", "info", "ai-reply");
                    }} />
                  </div>
                  {autoReplyEnabled && (
                    <div className="flex items-center gap-2 text-xs text-green-400 bg-green-400/5 border border-green-400/20 rounded px-3 py-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      Active — scanning every 60s
                    </div>
                  )}
                </div>

                <div className="rounded border border-border bg-card/60 p-4 space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    <MessageSquare className="w-3.5 h-3.5 text-primary" /> Manual Reply
                  </h3>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest">Message to Reply To</Label>
                    <Textarea placeholder="Paste the message you received..." value={aiContext} onChange={(e) => setAiContext(e.target.value)} className="min-h-[80px] text-sm resize-y bg-input border-border" />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest">Channel ID (auto-sends if set)</Label>
                    <Input placeholder="Channel ID..." value={aiChannelId} onChange={(e) => setAiChannelId(e.target.value)} className="font-mono text-sm bg-input border-border" />
                  </div>
                  <Button className="w-full bg-primary/80 hover:bg-primary" onClick={() => handleGenerateAIReply(undefined, aiChannelId || undefined)} disabled={!aiContext || generateAIReplyMutation.isPending}>
                    {generateAIReplyMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating...</> : <><Bot className="w-4 h-4 mr-2" />Generate Reply</>}
                  </Button>
                  {generatedReply && (
                    <div className="p-3 rounded border border-primary/20 bg-primary/5 text-sm leading-relaxed">
                      <div className="text-[9px] uppercase tracking-widest text-primary mb-2">Generated Reply</div>
                      {generatedReply}
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded border border-border bg-card/60 p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    <MessageSquare className="w-3.5 h-3.5 text-primary" /> DM Conversations
                  </h3>
                  <Button size="sm" variant="outline" className="h-7 text-xs border-border hover:border-primary/40" onClick={handleFetchDMs} disabled={fetchDMsMutation.isPending}>
                    {fetchDMsMutation.isPending ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Loading...</> : <><RefreshCw className="w-3 h-3 mr-1.5" />Fetch DMs</>}
                  </Button>
                </div>
                {dms.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-xs font-mono border border-dashed border-border/50 rounded">
                    {aiToken ? "Click 'Fetch DMs' to load conversations" : "Enter a Discord token above, then fetch DMs"}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {dms.map((dm) => (
                      <div key={dm.channelId} className="flex items-start gap-3 p-3 rounded border border-border hover:border-primary/30 bg-background/30 group transition-colors">
                        <Avatar className="w-8 h-8 border border-border shrink-0">
                          <AvatarImage src={dm.avatar ? `https://cdn.discordapp.com/avatars/${dm.userId}/${dm.avatar}.png` : undefined} />
                          <AvatarFallback className="bg-primary/20 text-primary text-xs font-bold">{dm.username.charAt(0).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-sm font-medium">{dm.username}</span>
                            {dm.fromMe && <Badge variant="outline" className="text-[9px] border-primary/30 text-primary px-1">You</Badge>}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">{dm.lastMessage || "(empty)"}</div>
                        </div>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-primary hover:bg-primary/10 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          onClick={() => { setAiContext(dm.lastMessage); setAiChannelId(dm.channelId); handleGenerateAIReply(dm.lastMessage, dm.channelId); }}
                          disabled={dm.fromMe || generateAIReplyMutation.isPending}>
                          <Bot className="w-3 h-3 mr-1" />AI Reply
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TOKENS */}
          {activeView === "tokens" && (
            <div className="max-w-2xl space-y-4">
              <div className="rounded border border-border bg-card/60 p-5 space-y-4">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                  <Key className="w-3.5 h-3.5 text-primary" /> Validate Discord Token
                </h3>
                <div className="flex gap-2">
                  <Input type="password" placeholder="Enter Discord user token..." value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} className="font-mono text-sm bg-input border-border focus-visible:ring-primary/50" />
                  <Button onClick={handleValidateToken} disabled={!tokenInput || validateTokenMutation.isPending} className="bg-primary/80 hover:bg-primary shrink-0">
                    {validateTokenMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Validate"}
                  </Button>
                </div>
                {tokenInfo?.valid && (
                  <div className="flex items-center gap-3 p-3 rounded border border-green-500/20 bg-green-500/5">
                    <Avatar className="w-10 h-10 border border-border">
                      <AvatarImage src={tokenInfo.avatar ? `https://cdn.discordapp.com/avatars/${tokenInfo.id}/${tokenInfo.avatar}.png` : undefined} />
                      <AvatarFallback className="bg-primary/20 text-primary font-bold">{tokenInfo.username?.charAt(0).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <div className="font-semibold text-sm">{tokenInfo.username}<span className="text-muted-foreground">#{tokenInfo.discriminator}</span></div>
                      <div className="text-xs text-muted-foreground font-mono">{tokenInfo.id}</div>
                    </div>
                    <Badge className="bg-green-500/10 text-green-400 border-green-500/20">Valid</Badge>
                  </div>
                )}
                {tokenInfo && !tokenInfo.valid && (
                  <div className="flex items-center gap-2 p-3 rounded border border-red-500/20 bg-red-500/5 text-red-400 text-sm">
                    <XCircle className="w-4 h-4 shrink-0" /> {tokenInfo.error || "Invalid token"}
                  </div>
                )}
              </div>
              <div className="rounded border border-border bg-card/60 p-4 space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">How to Get Your Token</h3>
                <div className="space-y-1.5 text-xs text-muted-foreground leading-relaxed">
                  <p>1. Open Discord in your browser (discord.com)</p>
                  <p>2. Press F12 to open DevTools and go to the Network tab</p>
                  <p>3. Send a message or interact with the app to trigger a request</p>
                  <p className="pt-1 text-amber-400/80">Warning: Never share your token. Treat it like a password.</p>
                </div>
              </div>
            </div>
          )}

          {/* LOGS */}
          {activeView === "logs" && (
            <div className="max-w-4xl">
              <div className="rounded border border-border bg-card/60 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background/40">
                  <div className="flex items-center gap-2">
                    <History className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Activity Log</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[10px]">{logs.length} messages</Badge>
                    <Button size="sm" variant="ghost" className="h-6 text-xs text-muted-foreground px-2" onClick={() => setLogs([])}>Clear</Button>
                  </div>
                </div>
                <ScrollArea className="h-[calc(100vh-220px)]">
                  {logs.length === 0 ? (
                    <div className="flex items-center justify-center h-48 text-muted-foreground font-mono text-xs">No messages logged yet...</div>
                  ) : (
                    <div className="font-mono text-xs divide-y divide-border/40">
                      {logs.map((log) => (
                        <div key={log.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-secondary/20 transition-colors">
                          <span className="text-muted-foreground whitespace-nowrap shrink-0 pt-0.5">{log.timestamp.toLocaleTimeString(undefined, { hour12: false })}</span>
                          {log.type === "success" && <CheckCircle className="w-3.5 h-3.5 text-green-400 mt-0.5 shrink-0" />}
                          {log.type === "error" && <XCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />}
                          {log.type === "info" && <div className="w-3.5 h-3.5 mt-0.5 shrink-0 flex items-center justify-center"><div className="w-1.5 h-1.5 rounded-full bg-blue-400" /></div>}
                          <span className={`leading-relaxed ${log.type === "success" ? "text-green-300/90" : log.type === "error" ? "text-red-300/90" : "text-foreground/70"}`}>
                            {log.view && <span className="text-primary/60 mr-2">[{log.view}]</span>}
                            {log.message}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </div>
          )}

        </main>
      </div>
    </div>
  );
}
