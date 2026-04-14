import React, { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useValidateToken, useGenerateAIReply, useRunAutoReply, useFetchDMs,
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useClerk, useUser } from "@clerk/react";
import {
  LayoutDashboard, Zap, Key, Bot, History, ChevronRight,
  Play, Square, Save, Trash2, RefreshCw, Plus, Edit2,
  Activity, Clock, TrendingUp, MessageSquare,
  Cpu, Radio, AlertTriangle, CheckCircle, XCircle, Loader2,
  ChevronDown, ChevronUp, Shield, Gauge, RotateCcw, FlaskConical,
  Filter, X, MoreVertical, Copy, LogOut,
} from "lucide-react";
import logoUrl from "/logo.png";

type View = "dashboard" | "autosender" | "ai-reply" | "tokens" | "logs";

type ServerCampaign = {
  id: number; name: string; token: string; channels: string[];
  message: string; delay: number; jitter: number; running: boolean;
  sentCount: number; failedCount: number; rateLimitBonus: number;
  rateLimitProtection: boolean; sentToday: number; nextSendAt: string | null;
  lastSentAt: string | null; createdAt: string; consecutiveFailures: number;
};

type CampaignLog = {
  id: number; campaignId: number;
  type: "success" | "warning" | "error";
  message: string; details: string | null; suggestion: string | null;
  channelId: string | null; timestamp: string;
};

type TestResult = { channelId: string; success: boolean; status: number; error?: string; suggestion?: string };

const API = `${import.meta.env.BASE_URL}api`;

/* ─── Hooks ─────────────────────────────────────────────── */
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

function useGetCampaignLogs(id: number | null, filter: string, enabled: boolean) {
  return useQuery<CampaignLog[]>({
    queryKey: ["campaign-logs", id, filter],
    queryFn: async () => {
      const params = filter !== "all" ? `?type=${filter}` : "";
      const res = await fetch(`${API}/campaigns/${id}/logs${params}`);
      if (!res.ok) throw new Error("Failed to fetch logs");
      return res.json();
    },
    enabled: enabled && id !== null,
    refetchInterval: enabled ? 3000 : false,
  });
}

function useGetUserSettings() {
  return useQuery<{ aiToken: string; aiPersona: string }>({
    queryKey: ["user-settings"],
    queryFn: async () => {
      const res = await fetch(`${API}/user-settings`);
      if (!res.ok) return { aiToken: "", aiPersona: "" };
      return res.json();
    },
  });
}

function useSaveUserSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { aiToken: string; aiPersona: string }) => {
      const res = await fetch(`${API}/user-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save settings");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-settings"] }),
  });
}

function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; token: string; channels: string[]; message: string; delay: number; jitter: number }) => {
      const res = await fetch(`${API}/campaigns`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      if (!res.ok) throw new Error("Failed to create");
      return res.json() as Promise<ServerCampaign>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

function useUpdateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: Partial<ServerCampaign> & { id: number }) => {
      const res = await fetch(`${API}/campaigns/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      if (!res.ok) throw new Error("Failed to update");
      return res.json() as Promise<ServerCampaign>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

function useDeleteCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await fetch(`${API}/campaigns/${id}`, { method: "DELETE" });
      qc.removeQueries({ queryKey: ["campaign-logs", id] });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

function useDuplicateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/campaigns/${id}/duplicate`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to duplicate");
      return res.json() as Promise<ServerCampaign>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

function useStartCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/campaigns/${id}/start`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to start");
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
      if (!res.ok) throw new Error("Failed to stop");
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
      if (!res.ok) throw new Error("Failed to reset");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

function useTestSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number): Promise<{ results: TestResult[] }> => {
      const res = await fetch(`${API}/campaigns/${id}/test-send`, { method: "POST" });
      if (!res.ok) throw new Error("Test send failed");
      return res.json();
    },
    onSuccess: (_data, id) => qc.invalidateQueries({ queryKey: ["campaign-logs", id] }),
  });
}

function useToggleRateLimitProtection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, enabled }: { id: number; enabled: boolean }) => {
      const res = await fetch(`${API}/campaigns/${id}/rate-limit-protection`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<ServerCampaign>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

function useClearLogs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await fetch(`${API}/campaigns/${id}/logs`, { method: "DELETE" });
    },
    onSuccess: (_d, id) => qc.invalidateQueries({ queryKey: ["campaign-logs", id] }),
  });
}

function useLocalState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : initial; }
    catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }, [key, value]);
  return [value, setValue] as const;
}

/* ─── Countdown hook ─────────────────────────────────────── */
function useCountdown(target: string | null): string {
  const [display, setDisplay] = useState("");
  useEffect(() => {
    if (!target) { setDisplay(""); return; }
    const update = () => {
      const diff = new Date(target).getTime() - Date.now();
      if (diff <= 0) { setDisplay("Now"); return; }
      const s = Math.floor(diff / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      if (h > 0) setDisplay(`${h}h ${m % 60}m ${s % 60}s`);
      else if (m > 0) setDisplay(`${m}m ${s % 60}s`);
      else setDisplay(`${s}s`);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [target]);
  return display;
}

/* ─── Campaign Log Dialog ─────────────────────────────────── */
type LogFilter = "all" | "success" | "warning" | "error";
const LOG_ICONS: Record<string, React.ReactNode> = {
  success: <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />,
  warning: <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />,
  error: <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />,
};
const LOG_COLORS: Record<string, string> = {
  success: "text-green-300/90",
  warning: "text-amber-300/90",
  error: "text-red-300/90",
};

function CampaignLogDialog({ campaignId, campaignName, open, onClose }: {
  campaignId: number; campaignName: string; open: boolean; onClose: () => void;
}) {
  const [filter, setFilter] = useState<LogFilter>("all");
  const [logTab, setLogTab] = useState<"today" | "all">("all");
  const { data: logs = [], isLoading } = useGetCampaignLogs(campaignId, filter, open);
  const clearLogs = useClearLogs();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
  const todayLogs = logs.filter((l) => new Date(l.timestamp) >= todayMidnight);
  const displayLogs = logTab === "today" ? todayLogs : logs;

  const counts = {
    all: logs.length,
    success: logs.filter((l) => l.type === "success").length,
    warning: logs.filter((l) => l.type === "warning").length,
    error: logs.filter((l) => l.type === "error").length,
  };
  const todayCounts = {
    all: todayLogs.length,
    success: todayLogs.filter((l) => l.type === "success").length,
    warning: todayLogs.filter((l) => l.type === "warning").length,
    error: todayLogs.filter((l) => l.type === "error").length,
  };
  const activeCounts = logTab === "today" ? todayCounts : counts;

  const tabs: { key: LogFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "success", label: "Success" },
    { key: "warning", label: "Warning" },
    { key: "error", label: "Error" },
  ];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl bg-[#1a1a1f] border border-border text-foreground p-0 gap-0 rounded-xl">
        <DialogHeader className="px-5 pt-5 pb-4 border-b border-border">
          <DialogTitle className="text-base font-semibold">Campaign Activity Log</DialogTitle>
          <p className="text-xs text-muted-foreground mt-0.5">View real-time activity logs for <span className="text-foreground">{campaignName}</span>.</p>
        </DialogHeader>

        <div className="px-5 pt-4 pb-2 space-y-3">
          <div className="flex gap-1.5 mb-1">
            {[["today", "Today"], ["all", "All Time"]].map(([k, l]) => (
              <button key={k} onClick={() => setLogTab(k as "today" | "all")}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${logTab === k ? "bg-primary/20 text-primary border border-primary/30" : "text-muted-foreground hover:text-foreground hover:bg-secondary/40"}`}>
                {l}
              </button>
            ))}
            <div className="flex-1" />
            <Button size="sm" variant="ghost" className="h-6 text-xs text-muted-foreground px-2 hover:text-red-400"
              onClick={() => clearLogs.mutate(campaignId)} disabled={clearLogs.isPending}>
              Clear All
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Filter className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <div className="flex gap-1.5 flex-wrap">
              {tabs.map((t) => {
                const count = activeCounts[t.key];
                const isActive = filter === t.key;
                return (
                  <button key={t.key} onClick={() => setFilter(t.key)}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-all ${
                      isActive
                        ? "bg-primary text-white border-primary"
                        : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground bg-transparent"
                    }`}>
                    {t.label}
                    <span className={`text-[10px] font-mono ${isActive ? "bg-white/20" : "bg-secondary/60"} rounded-full px-1.5 min-w-[20px] text-center`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <ScrollArea className="h-72 mx-5 mb-5 rounded-lg border border-border bg-background/30">
          {isLoading ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-xs font-mono"><Loader2 className="w-4 h-4 animate-spin mr-2" />Loading...</div>
          ) : displayLogs.length === 0 ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-xs font-mono border border-dashed border-border/40 rounded m-2">
              No activity matched the current filter.
            </div>
          ) : (
            <div className="divide-y divide-border/30">
              {displayLogs.map((log) => {
                const isExpanded = expanded.has(log.id);
                const hasDetails = !!(log.details || log.suggestion);
                return (
                  <div key={log.id} className="px-3 py-2 hover:bg-secondary/10 transition-colors">
                    <div className="flex items-start gap-2.5">
                      <div className="mt-0.5">{LOG_ICONS[log.type]}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-xs leading-relaxed ${LOG_COLORS[log.type]}`}>{log.message}</span>
                          {log.channelId && (
                            <span className="text-[9px] font-mono text-muted-foreground/60 bg-secondary/40 rounded px-1">
                              {log.channelId}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                          {new Date(log.timestamp).toLocaleString(undefined, { hour12: false, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </div>
                        {isExpanded && hasDetails && (
                          <div className="mt-2 space-y-1.5">
                            {log.details && (
                              <div className="text-[11px] bg-secondary/30 rounded px-2 py-1.5 text-muted-foreground font-mono leading-relaxed">{log.details}</div>
                            )}
                            {log.suggestion && (
                              <div className="text-[11px] bg-amber-500/8 border border-amber-500/20 rounded px-2 py-1.5 text-amber-300/80 leading-relaxed">
                                <span className="font-semibold text-amber-400">Fix: </span>{log.suggestion}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      {hasDetails && (
                        <button onClick={() => setExpanded((p) => { const n = new Set(p); isExpanded ? n.delete(log.id) : n.add(log.id); return n; })}
                          className="text-muted-foreground hover:text-foreground shrink-0 mt-0.5">
                          {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Test Send Results Dialog ───────────────────────────── */
function TestSendDialog({ results, open, onClose }: {
  results: TestResult[] | null; open: boolean; onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md bg-[#1a1a1f] border border-border text-foreground p-0 gap-0 rounded-xl">
        <DialogHeader className="px-5 pt-5 pb-4 border-b border-border">
          <DialogTitle className="text-base font-semibold flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-primary" /> Test Send Results
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-0.5">One test message was sent to each channel.</p>
        </DialogHeader>
        <div className="px-5 py-4 space-y-2">
          {(results ?? []).map((r) => (
            <div key={r.channelId} className={`rounded-xl border p-3 ${r.success ? "border-green-500/20 bg-green-500/5" : "border-red-500/20 bg-red-500/5"}`}>
              <div className="flex items-start gap-2.5">
                {r.success ? <CheckCircle className="w-4 h-4 text-green-400 shrink-0 mt-0.5" /> : <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">{r.success ? "Success" : r.error}</span>
                    <span className="text-[10px] font-mono text-muted-foreground bg-secondary/40 rounded px-1.5">{r.channelId}</span>
                  </div>
                  {r.suggestion && !r.success && (
                    <div className="text-[11px] text-amber-400/80 mt-1.5 leading-relaxed">
                      <span className="font-semibold">Fix: </span>{r.suggestion}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Countdown Badge ─────────────────────────────────────── */
function CountdownBadge({ nextSendAt }: { nextSendAt: string | null }) {
  const cd = useCountdown(nextSendAt);
  if (!cd) return null;
  return (
    <span className="flex items-center gap-1 text-[10px] font-mono text-cyan-400/80 bg-cyan-400/8 border border-cyan-400/15 rounded-lg px-2 py-0.5">
      <Clock className="w-2.5 h-2.5" />Next in {cd}
    </span>
  );
}

/* ─── Main Home Component ─────────────────────────────────── */
export default function Home() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { signOut } = useClerk();
  const { user } = useUser();

  const validateTokenMutation = useValidateToken();
  const generateAIReplyMutation = useGenerateAIReply();
  const runAutoReplyMutation = useRunAutoReply();
  const fetchDMsMutation = useFetchDMs();

  const { data: campaigns = [], isLoading: campaignsLoading } = useGetCampaigns();
  const createCampaign = useCreateCampaign();
  const updateCampaign = useUpdateCampaign();
  const deleteCampaign = useDeleteCampaign();
  const duplicateCampaign = useDuplicateCampaign();
  const startCampaign = useStartCampaign();
  const stopCampaign = useStopCampaign();
  const resetStats = useResetStats();
  const testSend = useTestSend();
  const toggleRLP = useToggleRateLimitProtection();

  // User settings (synced to server)
  const { data: userSettings } = useGetUserSettings();
  const saveUserSettings = useSaveUserSettings();
  const saveSettingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [activeView, setActiveView] = useLocalState<View>("bb_view", "dashboard");

  const [drafts, setDrafts] = useLocalState<Record<number | string, {
    name: string; token: string; channelsInput: string; message: string;
    delay: number; jitter: number; expanded: boolean; editMode: boolean; tokenValid: boolean | null;
  }>>("bb_drafts", {});

  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useLocalState("bb_new_form", { name: "Campaign 1", token: "", channelsInput: "", message: "", delay: 15, jitter: 0 });

  const [tokenInput, setTokenInput] = useLocalState("bb_token_input", "");
  const [tokenInfo, setTokenInfo] = useLocalState<TokenValidationResult | null>("bb_token_info", null);

  // AI Reply — local state, synced to server
  const [aiToken, setAiTokenLocal] = useState("");
  const [aiPersona, setAiPersonaLocal] = useState("");
  const [aiContext, setAiContext] = useLocalState("bb_ai_context", "");
  const [aiChannelId, setAiChannelId] = useLocalState("bb_ai_channel", "");
  const [generatedReply, setGeneratedReply] = useLocalState("bb_ai_reply", "");
  const [dms, setDMs] = useState<DMConversation[]>([]);
  const [autoReplyEnabled, setAutoReplyEnabled] = useLocalState("bb_auto_reply", false);
  const autoReplyRef = useRef(autoReplyEnabled);
  autoReplyRef.current = autoReplyEnabled;
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Load user settings from server once
  useEffect(() => {
    if (userSettings && !settingsLoaded) {
      setAiTokenLocal(userSettings.aiToken || "");
      setAiPersonaLocal(userSettings.aiPersona || "");
      setSettingsLoaded(true);
    }
  }, [userSettings, settingsLoaded]);

  const setAiToken = (v: string) => {
    setAiTokenLocal(v);
    if (saveSettingsTimer.current) clearTimeout(saveSettingsTimer.current);
    saveSettingsTimer.current = setTimeout(() => {
      saveUserSettings.mutate({ aiToken: v, aiPersona });
    }, 1000);
  };

  const setAiPersona = (v: string) => {
    setAiPersonaLocal(v);
    if (saveSettingsTimer.current) clearTimeout(saveSettingsTimer.current);
    saveSettingsTimer.current = setTimeout(() => {
      saveUserSettings.mutate({ aiToken, aiPersona: v });
    }, 1000);
  };

  const [logDialogId, setLogDialogId] = useState<number | null>(null);
  const logDialogCampaign = campaigns.find((c) => c.id === logDialogId);

  const [testResults, setTestResults] = useState<TestResult[] | null>(null);
  const [showTestDialog, setShowTestDialog] = useState(false);

  useEffect(() => {
    campaigns.forEach((c) => {
      if (!drafts[c.id]) {
        setDrafts((p) => ({
          ...p,
          [c.id]: {
            name: c.name, token: c.token,
            channelsInput: c.channels.join("\n"),
            message: c.message, delay: c.delay, jitter: c.jitter,
            expanded: true, editMode: false, tokenValid: null,
          },
        }));
      }
    });
  }, [campaigns.map((c) => c.id).join(",")]);

  function getDraft(id: number) { return drafts[id] ?? null; }
  function setDraft(id: number, updates: Partial<(typeof drafts)[number]>) {
    setDrafts((p) => ({
      ...p,
      [id]: { ...(p[id] ?? { name: "", token: "", channelsInput: "", message: "", delay: 15, jitter: 0, expanded: true, editMode: false, tokenValid: null }), ...updates },
    }));
  }

  useEffect(() => {
    if (!autoReplyEnabled || !aiToken) return;
    const run = async () => {
      if (!autoReplyRef.current) return;
      try {
        await runAutoReplyMutation.mutateAsync({ data: { token: aiToken, persona: aiPersona || undefined } });
      } catch {}
    };
    run();
    const id = setInterval(run, 60000);
    return () => clearInterval(id);
  }, [autoReplyEnabled, aiToken]);

  const handleValidateToken = async () => {
    if (!tokenInput) return;
    try {
      const result = await validateTokenMutation.mutateAsync({ data: { token: tokenInput } });
      setTokenInfo(result);
      if (result.valid) toast({ title: "Token Valid", description: `Authenticated as ${result.username}` });
      else toast({ title: "Invalid Token", description: result.error || "Rejected", variant: "destructive" });
    } catch { toast({ title: "Error", description: "Validation failed.", variant: "destructive" }); }
  };

  const handleValidateCampaignToken = async (id: number, token: string) => {
    if (!token) return;
    try {
      const result = await validateTokenMutation.mutateAsync({ data: { token } });
      setDraft(id, { tokenValid: result.valid ?? false });
      if (result.valid) toast({ title: "Valid", description: `${result.username}#${result.discriminator}` });
      else toast({ title: "Invalid Token", description: result.error ?? "Rejected", variant: "destructive" });
    } catch { setDraft(id, { tokenValid: false }); }
  };

  const handleCreateCampaign = async () => {
    if (!newForm.name || !newForm.token || !newForm.channelsInput || !newForm.message) {
      toast({ title: "Missing fields", description: "Name, token, channels, and message required.", variant: "destructive" });
      return;
    }
    const channels = newForm.channelsInput.split(/[\n,]+/).map((c) => c.trim()).filter(Boolean);
    try {
      const created = await createCampaign.mutateAsync({ name: newForm.name, token: newForm.token, channels, message: newForm.message, delay: newForm.delay, jitter: newForm.jitter });
      setDraft(created.id, { name: newForm.name, token: newForm.token, channelsInput: newForm.channelsInput, message: newForm.message, delay: newForm.delay, jitter: newForm.jitter, expanded: true, editMode: false, tokenValid: null });
      setShowNewForm(false);
      setNewForm({ name: `Campaign ${campaigns.length + 2}`, token: "", channelsInput: "", message: "", delay: 15, jitter: 0 });
      toast({ title: "Campaign Created", description: created.name });
    } catch { toast({ title: "Error", description: "Failed to create campaign.", variant: "destructive" }); }
  };

  const handleSaveCampaign = async (id: number) => {
    const draft = getDraft(id);
    if (!draft) return;
    const channels = draft.channelsInput.split(/[\n,]+/).map((c) => c.trim()).filter(Boolean);
    try {
      await updateCampaign.mutateAsync({ id, name: draft.name, token: draft.token, channels, message: draft.message, delay: draft.delay, jitter: draft.jitter });
      setDraft(id, { editMode: false });
      toast({ title: "Saved", description: "Changes will take effect on next send cycle." });
    } catch { toast({ title: "Error", description: "Failed to save.", variant: "destructive" }); }
  };

  const handleStart = async (id: number) => {
    const draft = getDraft(id);
    if (draft) {
      const channels = draft.channelsInput.split(/[\n,]+/).map((c) => c.trim()).filter(Boolean);
      await updateCampaign.mutateAsync({ id, name: draft.name, token: draft.token, channels, message: draft.message, delay: draft.delay, jitter: draft.jitter }).catch(() => {});
    }
    try {
      await startCampaign.mutateAsync(id);
    } catch { toast({ title: "Error", description: "Failed to start campaign.", variant: "destructive" }); }
  };

  const handleStop = async (id: number) => {
    try { await stopCampaign.mutateAsync(id); }
    catch { toast({ title: "Error", description: "Failed to stop.", variant: "destructive" }); }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteCampaign.mutateAsync(id);
      setDrafts((p) => { const copy = { ...p }; delete copy[id]; return copy; });
    } catch { toast({ title: "Error", description: "Failed to delete.", variant: "destructive" }); }
  };

  const handleDuplicate = async (id: number) => {
    try {
      const created = await duplicateCampaign.mutateAsync(id);
      setDraft(created.id, { name: created.name, token: created.token, channelsInput: created.channels.join("\n"), message: created.message, delay: created.delay, jitter: created.jitter, expanded: true, editMode: false, tokenValid: null });
      toast({ title: "Campaign Duplicated", description: created.name });
    } catch { toast({ title: "Error", description: "Failed to duplicate.", variant: "destructive" }); }
  };

  const handleTestSend = async (id: number) => {
    try {
      const r = await testSend.mutateAsync(id);
      setTestResults(r.results);
      setShowTestDialog(true);
    } catch { toast({ title: "Error", description: "Test send failed. Check your token and channels.", variant: "destructive" }); }
  };

  const handleFetchDMs = async () => {
    if (!aiToken) { toast({ title: "No token", description: "Enter a token above.", variant: "destructive" }); return; }
    try {
      const result = await fetchDMsMutation.mutateAsync({ data: { token: aiToken } });
      setDMs(result);
    } catch { toast({ title: "Error", description: "Could not fetch DMs. Check your token.", variant: "destructive" }); }
  };

  const handleGenerateAIReply = async (contextOverride?: string, channelOverride?: string) => {
    const ctx = contextOverride ?? aiContext;
    if (!ctx) { toast({ title: "No context", description: "Enter a message to reply to.", variant: "destructive" }); return; }
    try {
      const res = await generateAIReplyMutation.mutateAsync({
        data: { context: ctx, persona: aiPersona || undefined, token: channelOverride ? aiToken : undefined, channelId: channelOverride },
      });
      setGeneratedReply(res.reply);
      if (res.sent) toast({ title: "Reply Sent" });
      else toast({ title: "Reply Generated" });
    } catch { toast({ title: "Error", description: "Failed to generate reply.", variant: "destructive" }); }
  };

  const runningCount = campaigns.filter((c) => c.running).length;
  const totalSent = campaigns.reduce((s, c) => s + c.sentCount, 0);
  const totalFailed = campaigns.reduce((s, c) => s + c.failedCount, 0);
  const totalSentToday = campaigns.reduce((s, c) => s + c.sentToday, 0);
  const successRate = totalSent + totalFailed > 0 ? ((totalSent / (totalSent + totalFailed)) * 100).toFixed(1) : "100.0";

  const navItems: { id: View; icon: React.ReactNode; label: string }[] = [
    { id: "dashboard", icon: <LayoutDashboard className="w-4 h-4" />, label: "Dashboard" },
    { id: "autosender", icon: <Radio className="w-4 h-4" />, label: "AutoSender" },
    { id: "ai-reply", icon: <Bot className="w-4 h-4" />, label: "AI Reply" },
    { id: "tokens", icon: <Key className="w-4 h-4" />, label: "Tokens" },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex justify-center overflow-y-auto cyber-grid">
      <div className="h-screen w-full max-w-[920px] flex overflow-hidden bg-background/95 border-x border-border/70">
      {/* Dialogs */}
      <CampaignLogDialog
        campaignId={logDialogId!}
        campaignName={logDialogCampaign?.name ?? ""}
        open={logDialogId !== null}
        onClose={() => setLogDialogId(null)}
      />
      <TestSendDialog results={testResults} open={showTestDialog} onClose={() => setShowTestDialog(false)} />

      {/* Sidebar */}
      <aside className="w-44 bg-sidebar border-r border-sidebar-border flex flex-col shrink-0">
        <div className="px-4 py-4 border-b border-sidebar-border">
          <div className="flex items-center gap-2.5">
            <img src={logoUrl} alt="logo" className="w-8 h-8 rounded-xl shrink-0 object-cover" />
            <div>
              <div className="font-bold text-sm text-foreground leading-tight">ballistiballs adv</div>
              <div className="text-[9px] text-muted-foreground font-mono uppercase tracking-widest">autosender</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {navItems.map((item) => (
            <button key={item.id} onClick={() => setActiveView(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 group ${
                activeView === item.id
                  ? "bg-primary/15 text-primary border border-primary/20"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
              }`}>
              <span className={activeView === item.id ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}>{item.icon}</span>
              {item.label}
              {item.id === "autosender" && runningCount > 0 && (
                <span className="ml-auto text-[10px] bg-green-500/20 text-green-400 border border-green-500/30 rounded-lg px-1.5 py-0.5 font-mono">{runningCount}</span>
              )}
              {activeView === item.id && !(item.id === "autosender" && runningCount > 0) && <ChevronRight className="w-3 h-3 ml-auto text-primary" />}
            </button>
          ))}
        </nav>

        <div className="px-4 py-3 border-t border-sidebar-border space-y-2">
          {user && (
            <div className="flex items-center gap-2">
              <Avatar className="w-6 h-6 shrink-0">
                <AvatarImage src={user.imageUrl} />
                <AvatarFallback className="bg-primary/20 text-primary text-[10px] font-bold">{user.firstName?.charAt(0) ?? "U"}</AvatarFallback>
              </Avatar>
              <span className="text-[10px] text-muted-foreground truncate flex-1">{user.primaryEmailAddress?.emailAddress ?? user.fullName}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className={`w-1.5 h-1.5 rounded-full ${runningCount > 0 ? "bg-green-400 animate-pulse" : "bg-muted-foreground/40"}`} />
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest flex-1">
              {runningCount > 0 ? `${runningCount} live` : "Idle"}
            </span>
            {user && (
              <button onClick={() => signOut({ redirectUrl: "/" })} className="text-muted-foreground hover:text-red-400 transition-colors" title="Sign out">
                <LogOut className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="border-b border-border bg-card/40 px-4 py-3.5 flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-base font-semibold text-foreground capitalize">{activeView === "ai-reply" ? "AI Reply" : activeView}</h1>
            <p className="text-xs text-muted-foreground">
              {activeView === "dashboard" && "Discord automation command center"}
              {activeView === "autosender" && `Server-side scheduling — ${runningCount} active, runs offline`}
              {activeView === "ai-reply" && "Generate context-aware DM replies with AI"}
              {activeView === "tokens" && "Validate and manage Discord user tokens"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {runningCount > 0 && <Badge className="bg-green-500/10 text-green-400 border-green-500/20 font-mono text-[10px] animate-pulse">{runningCount} LIVE</Badge>}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4">

          {/* ── DASHBOARD ── */}
          {activeView === "dashboard" && (
            <div className="space-y-5 max-w-2xl mx-auto">
              <div className="flex items-start gap-3 p-3 rounded-xl border border-amber-500/20 bg-amber-500/5 text-amber-400/90">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <p className="text-xs leading-relaxed">Self-botting via user tokens violates Discord's Terms of Service and may result in account termination. Use at your own risk.</p>
              </div>

              <div className="grid grid-cols-1 gap-3">
                <div className="rounded-xl border border-border bg-card/60 p-4">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-1.5">
                    <Activity className="w-3 h-3 text-primary" />Today
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-2xl font-bold font-mono text-green-400">{totalSentToday}</div>
                      <div className="text-[10px] text-muted-foreground">Messages Sent</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold font-mono text-primary">{runningCount}</div>
                      <div className="text-[10px] text-muted-foreground">Campaigns Active</div>
                    </div>
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card/60 p-4">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-1.5">
                    <TrendingUp className="w-3 h-3 text-primary" />All Time
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-2xl font-bold font-mono text-green-400">{totalSent}</div>
                      <div className="text-[10px] text-muted-foreground">Successful Sends</div>
                    </div>
                    <div>
                      <div className={`text-2xl font-bold font-mono ${totalFailed > 0 ? "text-red-400" : "text-muted-foreground/40"}`}>{totalFailed}</div>
                      <div className="text-[10px] text-muted-foreground">Failed Sends</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  { label: "Campaigns", value: campaigns.length, icon: <Radio className="w-4 h-4" />, sub: `${runningCount} running`, color: "text-primary" },
                  { label: "Channels", value: campaigns.reduce((s, c) => s + c.channels.length, 0), icon: <MessageSquare className="w-4 h-4" />, sub: "All campaigns", color: "text-violet-300" },
                  { label: "Success Rate", value: `${successRate}%`, icon: <CheckCircle className="w-4 h-4" />, sub: "Combined", color: totalFailed === 0 ? "text-green-400" : "text-amber-400" },
                ].map((stat) => (
                  <div key={stat.label} className="p-4 rounded-xl border border-border bg-card/60">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{stat.label}</span>
                      <span className={stat.color}>{stat.icon}</span>
                    </div>
                    <div className={`text-2xl font-bold font-mono ${stat.color}`}>{stat.value}</div>
                    <div className="text-[10px] text-muted-foreground mt-1">{stat.sub}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 gap-3">
                {[
                  { icon: <Shield className="w-3.5 h-3.5" />, label: "Anti-Detection", desc: "UA rotation + human delays + burst breaks", color: "text-cyan-400 border-cyan-400/20 bg-cyan-400/5" },
                  { icon: <Gauge className="w-3.5 h-3.5" />, label: "Adaptive Rate Limit", desc: "Auto-increases interval on 429 errors", color: "text-amber-400 border-amber-400/20 bg-amber-400/5" },
                  { icon: <Activity className="w-3.5 h-3.5" />, label: "Offline Sending", desc: "Server-side — runs 24/7 even when tab is closed", color: "text-green-400 border-green-400/20 bg-green-400/5" },
                ].map((f) => (
                  <div key={f.label} className={`flex items-start gap-3 p-3 rounded-xl border text-xs ${f.color}`}>
                    <span className="mt-0.5 shrink-0">{f.icon}</span>
                    <div>
                      <div className="font-semibold mb-0.5">{f.label}</div>
                      <div className="opacity-80">{f.desc}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-border bg-card/60 p-4">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
                  <Radio className="w-3.5 h-3.5 text-primary" />Campaign Status
                </h3>
                {campaigns.length === 0 ? (
                  <div className="text-center py-6 text-muted-foreground text-xs font-mono">No campaigns yet. Go to AutoSender to create one.</div>
                ) : (
                  <div className="space-y-2">
                    {campaigns.map((c) => (
                      <div key={c.id} className="flex items-center gap-3 px-3 py-2 rounded-xl border border-border bg-background/30">
                        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.running ? "bg-green-400 animate-pulse" : "bg-muted-foreground/40"}`} />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium truncate">{c.name}</div>
                          <div className="text-[10px] text-muted-foreground font-mono">
                            {c.channels.length} ch · {c.delay + c.rateLimitBonus}s interval{c.rateLimitBonus > 0 && ` (+${c.rateLimitBonus}s RL)`}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <div className="text-right">
                            <div className="text-xs font-mono text-green-400">{c.sentToday} today</div>
                            <div className="text-[9px] text-muted-foreground">{c.sentCount} all time</div>
                          </div>
                          {c.failedCount > 0 && (
                            <div className="text-right">
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

          {/* ── AUTOSENDER ── */}
          {activeView === "autosender" && (
            <div className="max-w-xl mx-auto space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className="bg-green-500/10 text-green-400 border-green-500/20 text-[10px] gap-1"><Activity className="w-2.5 h-2.5" />Server-side 24/7</Badge>
                  <Badge className="bg-cyan-500/10 text-cyan-400 border-cyan-500/20 text-[10px] gap-1"><Shield className="w-2.5 h-2.5" />Anti-detection</Badge>
                </div>
                <Button size="sm" className="h-8 bg-primary/80 hover:bg-primary text-white gap-1.5" onClick={() => setShowNewForm(!showNewForm)}>
                  <Plus className="w-3.5 h-3.5" />Add Campaign
                </Button>
              </div>

              {/* New campaign form */}
              {showNewForm && (
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-primary">New Campaign</h3>
                  <div className="grid grid-cols-1 gap-3">
                    <div>
                      <Label className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 block">Name</Label>
                      <Input value={newForm.name} onChange={(e) => setNewForm((p) => ({ ...p, name: e.target.value }))} className="h-8 text-sm bg-input border-border rounded-xl" placeholder="Campaign name..." />
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 block">Token</Label>
                      <Input type="password" value={newForm.token} onChange={(e) => setNewForm((p) => ({ ...p, token: e.target.value }))} className="h-8 font-mono text-xs bg-input border-border rounded-xl" placeholder="Discord user token..." />
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 block">Channel IDs</Label>
                      <Textarea value={newForm.channelsInput} onChange={(e) => setNewForm((p) => ({ ...p, channelsInput: e.target.value }))} className="min-h-[60px] font-mono text-xs resize-y bg-input border-border rounded-xl" placeholder="One per line or comma separated..." />
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 block">Message</Label>
                      <Textarea value={newForm.message} onChange={(e) => setNewForm((p) => ({ ...p, message: e.target.value }))} className="min-h-[60px] text-sm resize-y bg-input border-border rounded-xl" placeholder="Message to send..." />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 block">Interval (s)</Label>
                        <Input type="number" min="1" value={newForm.delay} onChange={(e) => setNewForm((p) => ({ ...p, delay: Math.max(1, Number(e.target.value)) }))} className="h-8 font-mono bg-input border-border rounded-xl" />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 flex items-center justify-between"><span>Jitter</span><span className="text-primary">{newForm.jitter}%</span></Label>
                        <Slider min={0} max={100} step={5} value={[newForm.jitter]} onValueChange={([v]) => setNewForm((p) => ({ ...p, jitter: v }))} className="mt-2" />
                      </div>
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

              {campaignsLoading && <div className="text-center py-8 text-muted-foreground text-xs font-mono">Loading campaigns...</div>}
              {!campaignsLoading && campaigns.length === 0 && !showNewForm && (
                <div className="text-center py-16 text-muted-foreground text-sm border border-dashed border-border/50 rounded-xl">No campaigns yet. Click "Add Campaign" to create one.</div>
              )}

              {campaigns.map((campaign) => {
                const draft = getDraft(campaign.id);
                const inEditMode = draft?.editMode ?? false;
                const displayDelay = campaign.delay + campaign.rateLimitBonus;

                return (
                  <div key={campaign.id} className={`rounded-2xl border bg-card/60 transition-colors ${campaign.running ? "border-primary/30 shadow-[0_0_16px_rgba(124,58,237,0.08)]" : "border-border"}`}>
                    {/* Header */}
                    <div className="flex items-center gap-2 px-4 py-4 flex-wrap">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${campaign.running ? "bg-green-400 animate-pulse" : "bg-muted-foreground/30"}`} />
                      <div className="font-semibold text-sm truncate max-w-[130px]">{campaign.name}</div>

                      {campaign.running && <CountdownBadge nextSendAt={campaign.nextSendAt} />}

                      {campaign.rateLimitBonus > 0 && (
                        <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-[9px] font-mono shrink-0">+{campaign.rateLimitBonus}s RL</Badge>
                      )}

                      {(campaign.sentCount > 0 || campaign.failedCount > 0) && (
                        <div className="flex items-center gap-2 text-[11px] font-mono shrink-0 ml-auto">
                          <span className="text-green-400">{campaign.sentToday} today</span>
                          <span className="text-muted-foreground/40">·</span>
                          <span className="text-muted-foreground/70">{campaign.sentCount} total</span>
                          {campaign.failedCount > 0 && <><span className="text-muted-foreground/40">·</span><span className="text-red-400">{campaign.failedCount} fail</span></>}
                        </div>
                      )}

                      {/* Action buttons row */}
                      <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                        {/* RL Protect toggle with tooltip */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center gap-1.5 border border-border/50 rounded-xl px-2 py-1 cursor-default">
                              <Gauge className="w-3 h-3 text-muted-foreground" />
                              <span className="text-[9px] text-muted-foreground font-mono hidden sm:block">RL Protect</span>
                              <Switch
                                checked={campaign.rateLimitProtection}
                                onCheckedChange={(v) => toggleRLP.mutate({ id: campaign.id, enabled: v })}
                                className="scale-[0.65] origin-right"
                              />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-[220px] text-center">
                            <p className="text-xs">Rate Limit Protection</p>
                            <p className="text-[10px] text-muted-foreground mt-0.5">Automatically increases the sending interval when Discord rate limits you, to prevent future limits.</p>
                          </TooltipContent>
                        </Tooltip>

                        {/* Start/Stop */}
                        <Button size="sm" className={`h-7 px-2.5 text-xs font-bold ${campaign.running ? "bg-red-600/80 hover:bg-red-600 text-white" : "bg-primary/80 hover:bg-primary text-white"}`}
                          onClick={() => campaign.running ? handleStop(campaign.id) : handleStart(campaign.id)}
                          disabled={startCampaign.isPending || stopCampaign.isPending}>
                          {campaign.running ? <><Square className="w-3 h-3 mr-1 fill-current" />Stop</> : <><Play className="w-3 h-3 mr-1 fill-current" />Start</>}
                        </Button>

                        {/* Edit button */}
                        <Button size="sm" variant="ghost" className={`h-7 px-2.5 text-xs ${inEditMode ? "text-primary" : "text-muted-foreground hover:text-primary"}`}
                          onClick={() => setDraft(campaign.id, { editMode: !inEditMode, expanded: true })}>
                          Edit
                        </Button>

                        {/* 3-dot menu */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground">
                              <MoreVertical className="w-3.5 h-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44 rounded-xl">
                            <DropdownMenuItem onClick={() => handleTestSend(campaign.id)} disabled={testSend.isPending}>
                              <FlaskConical className="w-3.5 h-3.5 mr-2" />Test Send
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setLogDialogId(campaign.id)}>
                              <History className="w-3.5 h-3.5 mr-2" />View Logs
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleDuplicate(campaign.id)} disabled={duplicateCampaign.isPending}>
                              <Copy className="w-3.5 h-3.5 mr-2" />Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => handleDelete(campaign.id)} className="text-red-400 focus:text-red-400">
                              <Trash2 className="w-3.5 h-3.5 mr-2" />Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>

                        {/* Expand/collapse */}
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" onClick={() => setDraft(campaign.id, { expanded: !(draft?.expanded ?? true) })}>
                          {(draft?.expanded ?? true) ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </Button>
                      </div>
                    </div>

                    {/* Editable Body */}
                    {(draft?.expanded ?? true) && draft && inEditMode && (
                      <div className="px-4 pb-5 border-t border-border/50 pt-4 space-y-4">
                        {campaign.running && (
                          <div className="flex items-center gap-2 text-[10px] text-amber-400/80 bg-amber-400/5 border border-amber-400/15 rounded-xl px-3 py-2">
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                            Editing while running — changes take effect on the next send cycle.
                          </div>
                        )}
                        <div className="space-y-3">
                          <div>
                            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 block">Name</Label>
                            <Input value={draft.name} onChange={(e) => setDraft(campaign.id, { name: e.target.value })} className="h-8 text-sm bg-input border-border rounded-xl" />
                          </div>
                          <div>
                            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center justify-between">
                              Token
                              {draft.tokenValid === true && <span className="text-green-400 flex items-center gap-1 text-[9px]"><CheckCircle className="w-3 h-3" />Valid</span>}
                              {draft.tokenValid === false && <span className="text-red-400 flex items-center gap-1 text-[9px]"><XCircle className="w-3 h-3" />Invalid</span>}
                            </Label>
                            <div className="flex gap-1.5">
                              <Input type="password" value={draft.token} onChange={(e) => setDraft(campaign.id, { token: e.target.value, tokenValid: null })} className="h-8 font-mono text-xs bg-input border-border rounded-xl flex-1" placeholder="Discord user token..." />
                              <Button size="sm" variant="outline" className="h-8 px-2 text-xs border-border rounded-xl shrink-0" onClick={() => handleValidateCampaignToken(campaign.id, draft.token)} disabled={!draft.token || validateTokenMutation.isPending}>Check</Button>
                            </div>
                          </div>
                          <div>
                            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center justify-between">
                              Channel IDs
                              <span className="text-primary font-mono text-[9px]">{draft.channelsInput.split(/[\n,]+/).filter(Boolean).length} ch</span>
                            </Label>
                            <Textarea value={draft.channelsInput} onChange={(e) => setDraft(campaign.id, { channelsInput: e.target.value })} className="min-h-[72px] font-mono text-xs resize-y bg-input border-border rounded-xl" placeholder="One per line or comma separated..." />
                          </div>
                          <div>
                            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 block">Message</Label>
                            <Textarea value={draft.message} onChange={(e) => setDraft(campaign.id, { message: e.target.value })} className="min-h-[72px] text-sm resize-y bg-input border-border rounded-xl" placeholder="Message to send..." />
                          </div>
                          <div className="rounded-xl border border-border bg-background/30 p-3 space-y-3">
                            <div>
                              <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1.5">
                                <Clock className="w-3 h-3" />Interval (s)
                                {campaign.rateLimitBonus > 0 && <span className="text-amber-400 text-[9px]">→ {displayDelay}s effective</span>}
                              </Label>
                              <Input type="number" min="1" value={draft.delay} onChange={(e) => setDraft(campaign.id, { delay: Math.max(1, Number(e.target.value)) })} className="h-8 font-mono bg-input border-border rounded-xl" />
                            </div>
                            <div>
                              <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center justify-between">
                                <span>Jitter</span><span className="text-primary font-mono">{draft.jitter}%</span>
                              </Label>
                              <Slider min={0} max={100} step={5} value={[draft.jitter]} onValueChange={([v]) => setDraft(campaign.id, { jitter: v })} />
                            </div>
                          </div>
                          <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 text-[10px] text-cyan-400/80 space-y-1">
                            <div className="font-semibold text-cyan-400 flex items-center gap-1.5 mb-1"><Shield className="w-3 h-3" />Anti-Detection</div>
                            <div>✓ Random User-Agent per request</div>
                            <div>✓ Human-like delays 0.6–2.5s between channels</div>
                            <div>✓ Burst break every 15 cycles (+30–90s pause)</div>
                          </div>
                          <Button size="sm" variant="default" className="w-full h-8 text-xs bg-primary/80 hover:bg-primary rounded-xl"
                            onClick={() => handleSaveCampaign(campaign.id)} disabled={updateCampaign.isPending}>
                            <Save className="w-3 h-3 mr-1.5" />Save Changes
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Collapsed read-only view */}
                    {(draft?.expanded ?? true) && draft && !inEditMode && (
                      <div className="px-4 pb-4 border-t border-border/50 pt-3 grid grid-cols-2 gap-3 text-[11px]">
                        <div>
                          <div className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Channels</div>
                          <div className="font-mono text-foreground/80">{campaign.channels.length} channel{campaign.channels.length !== 1 ? "s" : ""}</div>
                        </div>
                        <div>
                          <div className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Interval</div>
                          <div className="font-mono text-foreground/80">{displayDelay}s{campaign.rateLimitBonus > 0 ? ` (+${campaign.rateLimitBonus}s RL)` : ""}</div>
                        </div>
                        <div>
                          <div className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Jitter</div>
                          <div className="font-mono text-foreground/80">{campaign.jitter}%</div>
                        </div>
                        <div>
                          <div className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Last Sent</div>
                          <div className="font-mono text-foreground/80">{campaign.lastSentAt ? new Date(campaign.lastSentAt).toLocaleTimeString(undefined, { hour12: false }) : "Never"}</div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── AI REPLY ── */}
          {activeView === "ai-reply" && (
            <div className="max-w-xl mx-auto space-y-4">
              <div className="grid grid-cols-1 gap-4">
                <div className="rounded-xl border border-border bg-card/60 p-4 space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2"><Key className="w-3.5 h-3.5 text-primary" />Token & Persona</h3>
                  {saveUserSettings.isPending && (
                    <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin" />Saving to your account...
                    </div>
                  )}
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest">Discord Token (for DMs)</Label>
                    <Input type="password" placeholder="Enter token to fetch DMs and auto-reply..." value={aiToken} onChange={(e) => setAiToken(e.target.value)} className="font-mono text-sm bg-input border-border rounded-xl" />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest"><span className="flex items-center gap-1.5"><Cpu className="w-3 h-3 text-primary" />AI Persona (optional)</span></Label>
                    <Textarea placeholder="e.g. You are a friendly gamer. Keep replies casual and short..." value={aiPersona} onChange={(e) => setAiPersona(e.target.value)} className="min-h-[80px] text-sm resize-y bg-input border-border rounded-xl" />
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <div>
                      <Label className="text-sm font-medium cursor-pointer">Auto-Reply</Label>
                      <p className="text-[10px] text-muted-foreground">Scan and reply to DMs every 60s</p>
                    </div>
                    <Switch checked={autoReplyEnabled} onCheckedChange={(v) => {
                      if (v && !aiToken) { toast({ title: "No token", description: "Enter a Discord token above.", variant: "destructive" }); return; }
                      setAutoReplyEnabled(v);
                    }} />
                  </div>
                  {autoReplyEnabled && (
                    <div className="flex items-center gap-2 text-xs text-green-400 bg-green-400/5 border border-green-400/20 rounded-xl px-3 py-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />Active — scanning every 60s
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-border bg-card/60 p-4 space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2"><MessageSquare className="w-3.5 h-3.5 text-primary" />Manual Reply</h3>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest">Message to Reply To</Label>
                    <Textarea placeholder="Paste the message you received..." value={aiContext} onChange={(e) => setAiContext(e.target.value)} className="min-h-[80px] text-sm resize-y bg-input border-border rounded-xl" />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest">Channel ID (auto-sends if set)</Label>
                    <Input placeholder="Channel ID..." value={aiChannelId} onChange={(e) => setAiChannelId(e.target.value)} className="font-mono text-sm bg-input border-border rounded-xl" />
                  </div>
                  <Button className="w-full bg-primary/80 hover:bg-primary rounded-xl" onClick={() => handleGenerateAIReply(undefined, aiChannelId || undefined)} disabled={!aiContext || generateAIReplyMutation.isPending}>
                    {generateAIReplyMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating...</> : <><Bot className="w-4 h-4 mr-2" />Generate Reply</>}
                  </Button>
                  {generatedReply && (
                    <div className="p-3 rounded-xl border border-primary/20 bg-primary/5 text-sm leading-relaxed">
                      <div className="text-[9px] uppercase tracking-widest text-primary mb-2">Generated Reply</div>
                      {generatedReply}
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-border bg-card/60 p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2"><MessageSquare className="w-3.5 h-3.5 text-primary" />DM Conversations</h3>
                  <Button size="sm" variant="outline" className="h-7 text-xs border-border hover:border-primary/40 rounded-xl" onClick={handleFetchDMs} disabled={fetchDMsMutation.isPending}>
                    {fetchDMsMutation.isPending ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Loading...</> : <><RefreshCw className="w-3 h-3 mr-1.5" />Fetch DMs</>}
                  </Button>
                </div>
                {dms.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-xs font-mono border border-dashed border-border/50 rounded-xl">
                    {aiToken ? "Click 'Fetch DMs' to load conversations" : "Enter a Discord token above, then fetch DMs"}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {dms.map((dm) => (
                      <div key={dm.channelId} className="flex items-start gap-3 p-3 rounded-xl border border-border hover:border-primary/30 bg-background/30 group transition-colors">
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

          {/* ── TOKENS ── */}
          {activeView === "tokens" && (
            <div className="max-w-xl mx-auto space-y-4">
              <div className="rounded-xl border border-border bg-card/60 p-5 space-y-4">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2"><Key className="w-3.5 h-3.5 text-primary" />Validate Discord Token</h3>
                <div className="flex gap-2">
                  <Input type="password" placeholder="Enter Discord user token..." value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} className="font-mono text-sm bg-input border-border rounded-xl" />
                  <Button onClick={handleValidateToken} disabled={!tokenInput || validateTokenMutation.isPending} className="bg-primary/80 hover:bg-primary shrink-0 rounded-xl">
                    {validateTokenMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Validate"}
                  </Button>
                </div>
                {tokenInfo?.valid && (
                  <div className="flex items-center gap-3 p-3 rounded-xl border border-green-500/20 bg-green-500/5">
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
                  <div className="p-3 rounded-xl border border-red-500/20 bg-red-500/5 space-y-1.5">
                    <div className="flex items-center gap-2 text-red-400 text-sm"><XCircle className="w-4 h-4 shrink-0" />{tokenInfo.error || "Invalid token"}</div>
                    <div className="text-[11px] text-amber-400/80"><span className="font-semibold">Fix: </span>Make sure you copied the full token from Discord. Tokens are invalidated if you change your password.</div>
                  </div>
                )}
              </div>
              <div className="rounded-xl border border-border bg-card/60 p-4 space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">How to Get Your Token</h3>
                <div className="space-y-1.5 text-xs text-muted-foreground leading-relaxed">
                  <p>1. Open Discord in your browser (discord.com)</p>
                  <p>2. Press F12 to open DevTools and go to the Network tab</p>
                  <p>3. Send any message or interact with Discord to trigger a request</p>
                  <p>4. Find any request to discord.com, look at Headers → Authorization</p>
                  <p className="pt-1 text-amber-400/80">Warning: Never share your token. Treat it like a password.</p>
                </div>
              </div>
            </div>
          )}

        </main>
      </div>
      </div>
    </div>
  );
}
