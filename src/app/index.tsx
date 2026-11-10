import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import { CameraView, useCameraPermissions } from 'expo-camera';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, RefreshControl, Linking as RNLinking, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import 'react-native-url-polyfill/auto';

async function openWhatsAppChat(phone: string | null | undefined, message: string) {
  // keep only digits, drop leading zeros
  const digits = (phone ?? '').replace(/\D/g, '').replace(/^0+/, '');

  if (digits.length < 10) {
    Alert.alert('No phone number', "Add this member's phone number first.");
    return;
  }

  // 10-digit Indian number -> add 91 in front
  const number = digits.length === 10 ? '91' + digits : digits;
  const url = `https://wa.me/${number}?text=${encodeURIComponent(message)}`;

  try {
    await RNLinking.openURL(url);
  } catch {
    Alert.alert('Could not open WhatsApp');
  }
}
function startFromDaysAgo(v: string): string {
  const n = Math.min(3650, Math.max(0, parseInt(v, 10) || 0));
  // today's date in India, minus n days
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000 - n * 86400000);
  return ist.toISOString().slice(0, 10);
}

const isExpoGo = Constants.executionEnvironment === 'storeClient';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Notifications: typeof import('expo-notifications') | null = isExpoGo ? null : require('expo-notifications');

WebBrowser.maybeCompleteAuthSession();

// ---- SETTINGS ----
const APP_NAME = 'GymKhata'; // placeholder name, pick your own later
const SUPABASE_URL = 'https://tkskfydntjojgycbanqq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_2L4qHbvZ-YkKA0yFqkb0KA_lklpDjGI'; // public key, safe inside the app
const EXPIRY_WARNING_DAYS = 7;
const SUPPORT_WHATSAPP = '917382962612'; // your WhatsApp number: 91 then your 10 digits, no plus sign, no spaces
// ------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
});

Notifications?.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let currentPushToken: string | null = null;

// Web only: the browser has no Alert.alert, so use its own pop-ups instead
if (Platform.OS === 'web') {
  const w = globalThis as any;
  (Alert as any).alert = (title: string, message?: string, buttons?: any[]) => {
    const text = [title, message].filter(Boolean).join('\n\n');
    const list = buttons ?? [];
    const cancel = list.find((b) => b.style === 'cancel');
    const actions = list.filter((b) => b.style !== 'cancel');
    if (actions.length === 0 || (actions.length === 1 && !cancel)) {
      w.alert(text);
      actions[0]?.onPress?.();
    } else if (actions.length === 1) {
      if (w.confirm(text)) actions[0].onPress?.();
      else cancel?.onPress?.();
    } else {
      const menu = actions.map((b, i) => `${i + 1} = ${b.text}`).join('\n');
      const pick = w.prompt(`${text}\n\n${menu}\n\nType a number:`);
      actions[Number(pick) - 1]?.onPress?.();
    }
  };
    (Share as any).share = async (content: { message?: string; url?: string }) => {
    const text = content.message ?? content.url ?? '';
    try {
      await w.navigator.clipboard.writeText(text);
      w.alert('Copied. Paste it into WhatsApp or anywhere to send it.');
    } catch {
      w.prompt('Copy this text with Ctrl+C:', text);
    }
    return { action: 'sharedAction' };
  };
}
async function registerForPush(): Promise<string | null> {
  try {
    if (!Device.isDevice) return null;
       if (!Notifications || Platform.OS === 'web') return null;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
      });
    }
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return null;
    const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
        if (!projectId) {
      Alert.alert('Push setup problem', 'No project ID found in this build.');
      return null;
    }
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    currentPushToken = token;
    return token;
    } catch (e) {
    Alert.alert('Push setup problem', String(e));
    return null;
  }
}

async function sendPush(postId: string, title: string, body: string) {
  try {
    const { data, error } = await supabase.rpc('push_recipients', { p_post: postId });
    if (error) {
      Alert.alert('Push debug: recipients error', error.message);
      return;
    }
    const tokens = ((data ?? []) as { token: string }[]).map((r) => r.token).filter(Boolean);
    if (tokens.length === 0) {
      Alert.alert('Push debug', 'No recipients found for this post.');
      return;
    }
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens.map((to) => ({ to, title, body: body.slice(0, 150), sound: 'default' }))),
    });
    const out = await res.text();
    Alert.alert('Push debug', 'Sent to ' + tokens.length + ' token(s). Expo says: ' + out.slice(0, 300));
  } catch (e) {
    Alert.alert('Push debug: failed', String(e));
  }
}type StaffRole = 'owner' | 'manager' | 'receptionist' | 'trainer';
type Tab = 'home' | 'members' | 'attendance' | 'news' | 'manage' | 'refer';
type Status = 'Active' | 'Expiring' | 'Expired';
type Gym = { id: string; name: string; referral_reward: number; checkin_modes?: string[] };
type Branch = { id: string; gym_id: string; name: string; area: string };
type Staff = { id: string; gym_id: string; user_id: string | null; name: string; phone: string | null; role: StaffRole; branch_id: string | null; can_add_members: boolean; active: boolean };
type Plan = { id: string; gym_id: string; name: string; days: number; price: number };
type Member = {
  id: string; gym_id: string; user_id: string | null; home_branch_id: string | null; plan_id: string; name: string; phone: string;
  start_date: string; expiry_date: string; paid: boolean; credit: number; referral_code: string; referred_by: string | null; rewarded: boolean;
};
type CheckIn = { id: string; gym_id: string; member_id: string; branch_id: string | null; day: string; checked_in_at: string };
type Post = { id: string; gym_id: string; branch_id: string | null; title: string; body: string; created_at: string };
type Invite = { code: string; gym_id: string; kind: 'member' | 'staff'; member_id: string | null; staff_id: string | null; expires_at: string };
type RevenueRow = { month_start: string; branch_id: string | null; branch_name: string; total: number; cnt: number; cash: number; upi: number };
type AttendanceReport = {
  total: number;
  members: number;
  avg_per_day: number;
  by_branch: { branch_id: string | null; name: string; visits: number; members: number }[];
  by_hour: { hour: number; visits: number }[];
  inactive: { member_id: string; name: string; phone: string; last_visit: string | null; expiry_date: string }[];
};
type MemberHistory = {
  added_by: string | null;
  added_on: string;
  payments: { day: string; plan_name: string | null; amount: number; method: string | null; by: string | null }[];
};
type Profile =
  | { key: string; kind: 'staff'; gymId: string; gymName: string; staff: Staff }
  | { key: string; kind: 'member'; gymId: string; gymName: string; memberId: string };

const ROLE_LABEL: Record<StaffRole, string> = { owner: 'Owner', manager: 'Manager', receptionist: 'Receptionist', trainer: 'Trainer' };
const EDITABLE_ROLES: StaffRole[] = ['manager', 'receptionist', 'trainer'];
const ROLE_INFO: Record<StaffRole, string> = {
  owner: 'Can do everything.',
  manager: 'Collects payments, sends reminders and posts announcements. Adding members is up to you.',
  receptionist: 'Collects payments, sends reminders and marks attendance. Adding members is up to you.',
  trainer: 'Views members and marks attendance. Cannot see or collect money.',
};

// ---------- dates (India time) ----------
const pad = (n: number) => String(n).padStart(2, '0');
const toISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromISO = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const todayISO = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = fromISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
};
const daysBetween = (a: string, b: string) => Math.round((fromISO(b).getTime() - fromISO(a).getTime()) / 86400000);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDate = (iso: string) => {
  const d = fromISO(iso.slice(0, 10));
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
const timeOf = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const money = (n: number) => '₹' + Math.round(Number(n)).toLocaleString('en-IN');
const digits10 = (p: string) => p.replace(/\D/g, '').slice(-10);
// reads name=value pairs from both the ? part and the # part of a link
const paramsFromUrl = (url: string) => {
  const out: Record<string, string> = {};
  const [beforeHash, hash = ''] = url.split('#');
  const query = beforeHash.split('?')[1] ?? '';
  [query, hash].forEach((chunk) => {
    chunk.split('&').forEach((pair) => {
      if (!pair) return;
      const i = pair.indexOf('=');
      const key = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
      out[key] = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1));
    });
  });
  return out;
};
const fmtCode = (c: string) => (c.length === 10 ? `${c.slice(0, 5)}-${c.slice(5)}` : c);
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
const monthLabel = (iso: string) => `${MONTHS[fromISO(iso).getMonth()]} ${fromISO(iso).getFullYear()}`;

// ---------- member helpers ----------
const daysLeft = (m: Member) => daysBetween(todayISO(), m.expiry_date);
const statusOf = (m: Member): Status => {
  const d = daysLeft(m);
  return d < 0 ? 'Expired' : d <= EXPIRY_WARNING_DAYS ? 'Expiring' : 'Active';
};
const feeDue = (m: Member) => !m.paid || statusOf(m) === 'Expired';
const reasonText = (m: Member) => {
  const d = daysLeft(m);
  if (!m.paid && d >= 0) return 'Fee pending';
  if (d < 0) return `Expired ${-d} day${-d === 1 ? '' : 's'} ago`;
  if (d === 0) return 'Expires today';
  return `${d} day${d === 1 ? '' : 's'} left`;
};

// ---------- small components ----------
function Badge({ text, kind }: { text: string; kind: 'good' | 'warn' | 'bad' }) {
  return (
    <View style={[s.badge, kind === 'good' && s.badgeGood, kind === 'warn' && s.badgeWarn, kind === 'bad' && s.badgeBad]}>
      <Text style={[s.badgeText, kind === 'good' && s.textGood, kind === 'warn' && s.textWarn, kind === 'bad' && s.textBad]}>{text}</Text>
    </View>
  );
}
const statusBadge = (m: Member) => {
  const st = statusOf(m);
  if (st === 'Expired') return <Badge text="Expired" kind="bad" />;
  if (!m.paid) return <Badge text="Fee pending" kind="warn" />;
  if (st === 'Expiring') return <Badge text="Expiring" kind="warn" />;
  return <Badge text="Active" kind="good" />;
};
function Stat({ label, value, onPress }: { label: string; value: string | number; onPress?: () => void }) {
  const body = (
    <>
      <Text style={s.statNum}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </>
  );
  return onPress ? (
    <Pressable onPress={onPress} style={s.stat}>
      {body}
    </Pressable>
  ) : (
    <View style={s.stat}>{body}</View>
  );
}
function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.chip, on && s.chipOn]}>
      <Text style={[s.chipText, on && s.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.rowValue}>{value}</Text>
    </View>
  );
}
function Nav({ items, tab, onChange }: { items: { key: Tab; label: string }[]; tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <View style={s.nav}>
      {items.map((i) => (
        <Pressable key={i.key} style={s.navItem} onPress={() => onChange(i.key)}>
          <Text style={[s.navText, tab === i.key && s.navOn]}>{i.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
function Page({ children, onRefresh, refreshing }: { children: React.ReactNode; onRefresh?: () => void; refreshing?: boolean }) {
  return (
    <ScrollView
      contentContainerStyle={s.pad}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}
function Loading({ text }: { text: string }) {
  return (
    <SafeAreaView style={s.screen}>
      <View style={s.center}>
        <ActivityIndicator size="large" color={PRIMARY} />
        <Text style={[s.meta, { textAlign: 'center', marginTop: 12 }]}>{text}</Text>
      </View>
    </SafeAreaView>
  );
}
function Header({ title, sub, canSwitch, onSwitch, onSignOut }: { title: string; sub: string; canSwitch: boolean; onSwitch: () => void; onSignOut: () => void }) {
  return (
    <View style={s.header}>
      <View style={{ flexShrink: 1 }}>
        <Text style={s.headerTitle}>{title}</Text>
        <Text style={s.headerSub}>{sub}</Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 14 }}>
        {canSwitch && (
          <Pressable onPress={onSwitch}><Text style={s.switchText}>Switch</Text></Pressable>
        )}
        <Pressable onPress={onSignOut}><Text style={s.switchText}>Sign out</Text></Pressable>
      </View>
    </View>
  );
}

// =====================================================================
//  SIGN IN WITH EMAIL AND PASSWORD
// =====================================================================
function AuthScreen() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const g = globalThis as any;
    const href: string | undefined = g.location?.href;
    if (!href || !(href.includes('access_token=') || href.includes('code='))) return;
    (async () => {
      try {
        const params = paramsFromUrl(href);
        if (params.access_token && params.refresh_token) {
          await supabase.auth.setSession({ access_token: params.access_token, refresh_token: params.refresh_token });
        } else if (params.code) {
          await supabase.auth.exchangeCodeForSession(params.code);
        }
      } catch {
        // Supabase may already have handled it
      } finally {
        g.history?.replaceState(null, '', g.location.pathname);
      }
    })();
  }, []);

  const googleSignIn = async () => {
        if (Platform.OS === 'web') {
      setBusy(true);
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: (globalThis as any).location.origin },
      });
      if (error) {
        setBusy(false);
        Alert.alert('Google sign-in did not finish', error.message);
      }
      return;
    }
    const redirectTo = Linking.createURL('/');
    setBusy(true);
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true } });
      if (error) throw error;
      const res = await WebBrowser.openAuthSessionAsync(data.url ?? '', redirectTo);
      if (res.type === 'success') {
        const params = paramsFromUrl(res.url);
        if (params.error_description || params.error) throw new Error(params.error_description ?? params.error);
        if (params.access_token && params.refresh_token) {
          const { error: e2 } = await supabase.auth.setSession({ access_token: params.access_token, refresh_token: params.refresh_token });
          if (e2) throw e2;
        } else if (params.code) {
          const { error: e3 } = await supabase.auth.exchangeCodeForSession(params.code);
          if (e3) throw e3;
        } else {
          throw new Error('Google did not send back a sign-in.');
        }
      }
    } catch (err) {
      Alert.alert('Google sign-in did not finish', `${(err as Error).message}\n\nRedirect link used:\n${redirectTo}`);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const e = email.trim().toLowerCase();
    if (!e.includes('@') || e.length < 5) {
      Alert.alert('Check your email', 'Enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Check your password', 'Use at least 6 characters.');
      return;
    }
    setBusy(true);
    if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({ email: e, password });
      setBusy(false);
      if (error) {
        Alert.alert('Could not create account', error.message);
        return;
      }
      if (!data.session) {
        Alert.alert('Check your email', 'We sent you a link to confirm your email address. Open it, then come back and sign in.');
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: e, password });
      setBusy(false);
      if (error) Alert.alert('Could not sign in', error.message);
    }
  };

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.center}>
                {Platform.OS === 'web' && !(typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)) ? (
          <Pressable onPress={() => Linking.openURL('https://github.com/rayyankhan98/gymkhata-app/releases/latest/download/gymkhata.apk')} style={{ backgroundColor: '#EA580C', paddingVertical: 12, paddingHorizontal: 18, borderRadius: 12, alignSelf: 'flex-start', marginBottom: 20 }}>
            <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: 15 }}>Download the Android app</Text>
          </Pressable>
        ) : null}
        <Text style={s.logo}>{APP_NAME}</Text>
        <Text style={s.tagline}>{mode === 'signin' ? 'Sign in to your account.' : 'Create your account.'}</Text>
                        {Platform.OS === 'web' ? (
          <Pressable onPress={() => Linking.openURL('https://gymkhata.netlify.app/welcome.html')} style={{ marginTop: 6, marginBottom: 12 }}>
            <Text style={[s.meta, { textDecorationLine: 'underline' }]}>What is GymKhata? See what it does</Text>
          </Pressable>
        ) : null}
        <Pressable style={[s.googleBtn, busy && s.disabled]} disabled={busy} onPress={googleSignIn}>
          <Text style={s.googleBtnText}>Continue with Google</Text>
        </Pressable>
           {__DEV__ && <Text style={[s.meta, { textAlign: 'center', marginTop: 8 }]}>Return link: {Linking.createURL('/')}</Text>}
        <Text style={s.orText}>or use your email</Text>
        <Text style={s.label}>Email</Text>
        <TextInput style={s.input} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} value={email} onChangeText={setEmail} placeholder="you@example.com" />
        <Text style={s.label}>Password</Text>
        <TextInput style={s.input} secureTextEntry autoCapitalize="none" value={password} onChangeText={setPassword} placeholder="At least 6 characters" />
        <Pressable style={[s.primaryBtn, busy && s.disabled]} disabled={busy} onPress={submit}>
          <Text style={s.primaryBtnText}>{busy ? 'Please wait...' : mode === 'signin' ? 'Sign in' : 'Create account'}</Text>
        </Pressable>
        <Pressable style={s.secondaryBtn} onPress={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
          <Text style={s.secondaryBtnText}>{mode === 'signin' ? 'New here? Create an account' : 'Have an account? Sign in'}</Text>
        </Pressable>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 18 }}>
          {[['Terms', 'terms'], ['Privacy', 'privacy'], ['Refunds', 'refund'], ['Pricing', 'pricing'], ['About', 'about'], ['Contact', 'contact']].filter(([, p]) => IS_WEB || (p !== 'pricing' && p !== 'refund')).map(([label, page]) => (
            <Pressable key={page} onPress={() => Linking.openURL('https://gymkhata.netlify.app/' + page + '.html')}>
              <Text style={[s.meta, { textDecorationLine: 'underline', marginHorizontal: 8, paddingVertical: 4 }]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

// =====================================================================
//  JOIN A GYM WITH AN INVITE CODE
// =====================================================================
function InviteEntry({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const join = async () => {
    if (code.replace(/[^A-Za-z0-9]/g, '').length < 10) {
      Alert.alert('Check the code', 'The invite code has 10 letters and numbers.');
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc('claim_invite', { p_code: code });
    setBusy(false);
    if (error) {
      Alert.alert('Could not join', error.message);
      return;
    }
    const res = data as { ok?: boolean; message?: string } | null;
    if (!res || !res.ok) {
      Alert.alert('Could not join', res?.message ?? 'Try again.');
      return;
    }
    setCode('');
    onDone();
  };

  return (
    <View>
      <Text style={s.label}>Invite code</Text>
      <TextInput style={[s.input, s.codeInput]} autoCapitalize="characters" autoCorrect={false} value={code} onChangeText={setCode} placeholder="XXXXX-XXXXX" maxLength={12} />
      <Pressable style={[s.primaryBtn, busy && s.disabled]} disabled={busy} onPress={join}>
        <Text style={s.primaryBtnText}>{busy ? 'Please wait...' : 'Join gym'}</Text>
      </Pressable>
    </View>
  );
}

// =====================================================================
//  FIRST TIME: CREATE A GYM, OR JOIN WITH A CODE
// =====================================================================
function Onboarding({ onChanged, onSignOut }: { onChanged: () => void; onSignOut: () => void }) {
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>('choose');
  const [gymName, setGymName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!gymName.trim() || !ownerName.trim()) {
      Alert.alert('Check details', 'Enter your gym name and your name.');
      return;
    }
    const ph = ownerPhone.trim() ? digits10(ownerPhone) : null;
    if (ph && ph.length !== 10) {
      Alert.alert('Check the number', 'Enter a 10-digit mobile number or leave it empty.');
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc('create_gym', { p_gym_name: gymName, p_owner_name: ownerName, p_branch_name: branchName, p_owner_phone: ph });
    setBusy(false);
    if (error) {
      Alert.alert('Could not create gym', error.message);
      return;
    }
    onChanged();
  };

  if (mode === 'create') {
    return (
      <SafeAreaView style={s.screen}>
        <Page>
          <Pressable onPress={() => setMode('choose')}><Text style={s.back}>Back</Text></Pressable>
          <Text style={s.title}>Create your gym</Text>
          <Text style={s.label}>Gym name</Text>
          <TextInput style={s.input} value={gymName} onChangeText={setGymName} placeholder="For example, Iron House Gym" />
          <Text style={s.label}>Your name</Text>
          <TextInput style={s.input} value={ownerName} onChangeText={setOwnerName} placeholder="Owner name" />
          <Text style={s.label}>Your mobile number (optional)</Text>
          <TextInput style={s.input} keyboardType="phone-pad" value={ownerPhone} onChangeText={setOwnerPhone} placeholder="10-digit number" />
          <Text style={s.label}>First branch name</Text>
          <TextInput style={s.input} value={branchName} onChangeText={setBranchName} placeholder="For example, Banjara Hills" />
          <Pressable style={[s.primaryBtn, busy && s.disabled]} disabled={busy} onPress={create}>
            <Text style={s.primaryBtnText}>{busy ? 'Creating...' : 'Create gym'}</Text>
          </Pressable>
        </Page>
      </SafeAreaView>
    );
  }

  if (mode === 'join') {
    return (
      <SafeAreaView style={s.screen}>
        <Page>
          <Pressable onPress={() => setMode('choose')}><Text style={s.back}>Back</Text></Pressable>
          <Text style={s.title}>Join with an invite code</Text>
          <Text style={[s.bio, { marginBottom: 12 }]}>Your gym gives you a code when they add you. Enter it once to link your account.</Text>
          <InviteEntry onDone={onChanged} />
        </Page>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.center}>
        <Text style={s.title}>Welcome to {APP_NAME}</Text>
        <Pressable style={s.bigBtn} onPress={() => setMode('create')}>
          <Text style={s.bigBtnTitle}>I own a gym</Text>
          <Text style={s.bigBtnSub}>Set up your gym in a minute</Text>
        </Pressable>
        <Pressable style={[s.bigBtn, s.bigBtnAlt]} onPress={() => setMode('join')}>
          <Text style={[s.bigBtnTitle, { color: INK }]}>I have an invite code</Text>
          <Text style={[s.bigBtnSub, { color: '#4B5563' }]}>For members and staff</Text>
        </Pressable>
        <Pressable onPress={onSignOut} style={{ marginTop: 16 }}><Text style={[s.switchText, { textAlign: 'center' }]}>Sign out</Text></Pressable>
      </View>
    </SafeAreaView>
  );
}

function ProfilePicker({ profiles, onPick, onChanged, onSignOut }: { profiles: Profile[]; onPick: (k: string) => void; onChanged: () => void; onSignOut: () => void }) {
  return (
    <SafeAreaView style={s.screen}>
      <Page>
        <Text style={s.title}>Your gyms</Text>
        {profiles.map((p) => (
          <Pressable key={p.key} style={s.card} onPress={() => onPick(p.key)}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardName}>{p.gymName}</Text>
              <Text style={s.meta}>{p.kind === 'member' ? 'Member' : ROLE_LABEL[p.staff.role]}</Text>
            </View>
          </Pressable>
        ))}
        <Text style={s.section}>Join another gym</Text>
        <InviteEntry onDone={onChanged} />
        <Pressable onPress={onSignOut} style={{ marginTop: 24 }}><Text style={[s.switchText, { textAlign: 'center' }]}>Sign out</Text></Pressable>
      </Page>
    </SafeAreaView>
  );
}

// =====================================================================
//  OWNER AND STAFF VIEW
// =====================================================================
type Overlay =
  | { k: 'none' }
  | { k: 'member'; id: string }
  | { k: 'addMember' }
  | { k: 'addStaff' }
  | { k: 'staff'; id: string }
  | { k: 'branch'; id: string }
  | { k: 'plan'; id: string }
  | { k: 'liveQr' }
  | { k: 'staticQr' };

function StaffApp({ me, userId, canSwitch, onSwitch, onSignOut }: { me: Staff; userId: string; canSwitch: boolean; onSwitch: () => void; onSignOut: () => void }) {
  const gymId = me.gym_id;
  const [gym, setGym] = useState<Gym | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [checkins, setCheckins] = useState<CheckIn[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState<Invite[]>([]);

  const [tab, setTab] = useState<Tab>('home');
  const [overlay, setOverlay] = useState<Overlay>({ k: 'none' });
  const [scope, setScope] = useState('all');
  const [search, setSearch] = useState('');
  const [manageTab, setManageTab] = useState<'staff' | 'branches' | 'plans' | 'money' | 'reports'>('staff');
  // forms
  const [nName, setNName] = useState('');
  const [nPhone, setNPhone] = useState('');
  const [nPlan, setNPlan] = useState('');
  const [nPaid, setNPaid] = useState(true);
  const [nRunning, setNRunning] = useState(false);
const [nDaysAgo, setNDaysAgo] = useState('');
const [nCount, setNCount] = useState(true);
  const [nRef, setNRef] = useState('');
  const [nBranch, setNBranch] = useState('');
  const [sName, setSName] = useState('');
  const [sPhone, setSPhone] = useState('');
  const [sRole, setSRole] = useState<StaffRole>('receptionist');
  const [sBranch, setSBranch] = useState('');
  const [sCanAdd, setSCanAdd] = useState(true);
  const [bName, setBName] = useState('');
  const [bArea, setBArea] = useState('');
  const [plName, setPlName] = useState('');
  const [plDays, setPlDays] = useState('');
  const [plPrice, setPlPrice] = useState('');
  const [rewardText, setRewardText] = useState('');
  const [pTitle, setPTitle] = useState('');
  const [pBody, setPBody] = useState('');
  const [pAud, setPAud] = useState('all');

  const load = useCallback(async () => {
    const since = addDays(todayISO(), -30);
    const [g, b, st, p, m, c, po, iv] = await Promise.all([
      supabase.from('gyms').select('*').eq('id', gymId).single(),
      supabase.from('branches').select('*').eq('gym_id', gymId).order('created_at'),
      supabase.from('staff').select('*').eq('gym_id', gymId).order('created_at'),
      supabase.from('plans').select('*').eq('gym_id', gymId).order('days'),
      supabase.from('members').select('*').eq('gym_id', gymId).order('name'),
      supabase.from('checkins').select('*').eq('gym_id', gymId).gte('day', since),
      supabase.from('posts').select('*').eq('gym_id', gymId).order('created_at', { ascending: false }),
      supabase.from('invites').select('*').eq('gym_id', gymId),
    ]);
    const failed = [g, b, st, p, m, c, po, iv].find((r) => r.error);
    if (failed && failed.error) {
      Alert.alert('Could not load data', failed.error.message);
    } else {
      setGym(g.data as Gym);
      setBranches((b.data ?? []) as Branch[]);
      setStaff((st.data ?? []) as Staff[]);
      setPlans((p.data ?? []) as Plan[]);
      setMembers((m.data ?? []) as Member[]);
      setCheckins((c.data ?? []) as CheckIn[]);
      setPosts((po.data ?? []) as Post[]);
      setInvites((iv.data ?? []) as Invite[]);
    }
    setLoading(false);
    setRefreshing(false);
  }, [gymId]);

  useEffect(() => {
    load();
  }, [load]);
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day');
  const [report, setReport] = useState<{ bucket: string; total: number; cnt: number }[]>([]);

    const [scMonth, setScMonth] = useState(() => todayISO().slice(0, 7));
  const [scDays, setScDays] = useState<string[]>([]);
  const calMemberId = overlay.k === 'member' ? overlay.id : null;

  useEffect(() => {
    if (!calMemberId) return;
    const [cy, cm] = scMonth.split('-').map(Number);
    const firstDay = `${scMonth}-01`;
    const lastDay = toISO(new Date(cy, cm, 0));
    supabase
      .from('checkins')
      .select('day')
      .eq('member_id', calMemberId)
      .gte('day', firstDay)
      .lte('day', lastDay)
      .then(({ data }) => setScDays((data ?? []).map((r: { day: string }) => r.day)));
  }, [calMemberId, scMonth, checkins.length]);  
  const [collected, setCollected] = useState<{ method: string; total: number; cnt: number }[]>([]);
  const [payMethod, setPayMethod] = useState<'cash' | 'upi'>('cash');
    const [freezeText, setFreezeText] = useState('');
      const [history, setHistory] = useState<MemberHistory | null>(null);
  useEffect(() => {
    setHistory(null);
    if (!calMemberId || me.role !== 'owner') return;
    supabase.rpc('member_history', { p_member: calMemberId }).then(({ data }) => {
      if (data) setHistory(data as MemberHistory);
    });
  }, [calMemberId, me.role]);

  const loadCollected = useCallback(async () => {
    if (me.role !== 'owner') return;
    const { data } = await supabase.rpc('money_today', { p_gym: gymId, p_branch: scope === 'all' ? null : scope });
    setCollected((data ?? []) as { method: string; total: number; cnt: number }[]);
  }, [gymId, me.role, scope]);

  useEffect(() => {
    if (tab === 'home') loadCollected();
  }, [tab, loadCollected]);
  const loadReport = useCallback(async () => {
    const { data, error } = await supabase.rpc('money_report', {
      p_gym: gymId,
      p_period: period,
      p_branch: scope === 'all' ? null : scope,
    });
    if (error) {
      Alert.alert('Could not load money report', error.message);
      return;
    }
    setReport((data ?? []) as { bucket: string; total: number; cnt: number }[]);
  }, [gymId, period, scope]);

  useEffect(() => {
    if (me.role === 'owner' && tab === 'manage' && manageTab === 'money') loadReport();
  }, [me.role, tab, manageTab, loadReport]);

  // ----- owner reports: revenue by branch, expiring, attendance -----
  const [repTab, setRepTab] = useState<'revenue' | 'expiring' | 'attendance'>('revenue');
  const [revMonths, setRevMonths] = useState(6);
  const [revRows, setRevRows] = useState<RevenueRow[] | null>(null);
  const [expRange, setExpRange] = useState<'expired' | '7' | '15' | '30'>('7');
  const [attDays, setAttDays] = useState(30);
  const [attReport, setAttReport] = useState<AttendanceReport | null>(null);
  const [memberFilter, setMemberFilter] = useState<'all' | 'active' | 'expiring' | 'due' | 'today'>('all');
useEffect(() => {
  if (tab !== 'members') setMemberFilter('all');
}, [tab]);
  

  const loadRevenue = useCallback(async () => {
    setRevRows(null);
    const { data, error } = await supabase.rpc('report_revenue', { p_gym: gymId, p_months: revMonths });
    if (error) {
      Alert.alert('Could not load revenue', error.message);
      setRevRows([]);
      return;
    }
    setRevRows((data ?? []) as RevenueRow[]);
  }, [gymId, revMonths]);

    const [dowRows, setDowRows] = useState<{ dow: number; cnt: number }[]>([]);

  const loadDow = useCallback(async () => {
    const { data } = await supabase.rpc('owner_insights', {
      p_gym: gymId,
      p_days: attDays,
      p_branch: scope === 'all' ? null : scope,
    });
    const rows = (data as { by_weekday?: { dow: number; cnt: number }[] } | null)?.by_weekday ?? [];
    setDowRows(rows);
  }, [gymId, attDays, scope]);

  useEffect(() => {
    if (me.role === 'owner' && tab === 'manage' && manageTab === 'reports' && repTab === 'attendance') loadDow();
  }, [me.role, tab, manageTab, repTab, loadDow]);
  const loadAttendance = useCallback(async () => {
    setAttReport(null);
    const { data, error } = await supabase.rpc('report_attendance', {
      p_gym: gymId,
      p_days: attDays,
      p_branch: scope === 'all' ? null : scope,
    });
    if (error) {
      Alert.alert('Could not load attendance', error.message);
      return;
    }
    setAttReport(data as AttendanceReport);
  }, [gymId, attDays, scope]);

  useEffect(() => {
    if (me.role === 'owner' && tab === 'manage' && manageTab === 'reports' && repTab === 'revenue') loadRevenue();
  }, [me.role, tab, manageTab, repTab, loadRevenue]);

  useEffect(() => {
    if (me.role === 'owner' && tab === 'manage' && manageTab === 'reports' && repTab === 'attendance') loadAttendance();
  }, [me.role, tab, manageTab, repTab, loadAttendance]);

  const refresh = () => {
    setRefreshing(true);
    load();
  };

  // run a save, show any error, then reload the data
  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>): Promise<boolean> => {
    setBusy(true);
    const { error } = await fn();
    setBusy(false);
    if (error) {
      Alert.alert('Could not complete', error.message);
      return false;
    }
    await load();
    return true;
  };

  // like run, but hands back what the server returned (used for invite codes)
  const runData = async (fn: () => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<unknown> => {
    setBusy(true);
    const { data, error } = await fn();
    setBusy(false);
    if (error) {
      Alert.alert('Could not complete', error.message);
      return null;
    }
    await load();
    return data;
  };

  // ----- who am I right now (permissions can change while I am signed in) -----
  const meNow = staff.find((x) => x.id === me.id) ?? me;
  const isOwner = meNow.role === 'owner';
  const money_ = isOwner || meNow.role === 'manager' || meNow.role === 'receptionist';
  const canPost = isOwner || meNow.role === 'manager';
  const canAdd = isOwner || meNow.can_add_members;
  const activeBranch = isOwner ? scope : meNow.branch_id ?? 'all';
  const inScope = (branchId: string | null) => activeBranch === 'all' || branchId === activeBranch;
  const branchName = (id: string | null) => (id ? branches.find((b) => b.id === id)?.name ?? 'Branch' : 'All branches');
  const planOf = (m: Member) => plans.find((p) => p.id === m.plan_id);
  const scopedMembers = members.filter((m) => inScope(m.home_branch_id));
  const today = todayISO();
  const todays = checkins.filter((c) => c.day === today && inScope(c.branch_id));
  const checkedToday = (id: string) => checkins.find((c) => c.member_id === id && c.day === today);
  const memberName = (id: string) => members.find((m) => m.id === id)?.name ?? 'Member';
  const myBranchForActions = activeBranch !== 'all' ? activeBranch : meNow.branch_id ?? branches[0]?.id ?? null;
  const gymName = gym?.name ?? 'Your gym';

  // ----- invite codes -----
  const inviteFor = (kind: 'member' | 'staff', id: string) =>
    invites.find((i) => (kind === 'member' ? i.member_id === id : i.staff_id === id) && new Date(i.expires_at).getTime() > Date.now());
  const shareInvite = (code: string) => {
    Share.share({ message: `Join ${gymName} on ${APP_NAME}. Install the app, create an account with your email, choose "I have an invite code" and enter: ${fmtCode(code)}` });
  };
  const showInvite = (name: string, code: string) => {
    Alert.alert(`Invite ${name}`, `Invite code: ${fmtCode(code)}\n\nSend it to ${name}. It works once and expires in 30 days.`, [
      { text: 'Done', style: 'cancel' },
      { text: 'Share invite', onPress: () => shareInvite(code) },
    ]);
  };
  const newInvite = async (kind: 'member' | 'staff', id: string, name: string) => {
    const code = await runData(() => supabase.rpc('regenerate_invite', { p_kind: kind, p_target: id }));
    if (typeof code === 'string') showInvite(name, code);
  };

  // ----- actions -----
  const reminderText = (m: Member) => {
    const plan = planOf(m);
    const d = daysLeft(m);
    const pn = plan?.name ?? 'membership';
    let text: string;
    if (!m.paid && d >= 0) text = `Hi ${m.name}, your ${pn} fee${plan ? ` of ${money(plan.price)}` : ''} at ${gymName} is pending. Please pay at the front desk. Thank you!`;
    else if (d < 0) text = `Hi ${m.name}, your ${pn} membership at ${gymName} expired on ${niceDate(m.expiry_date)}. Renew today and get back on track!`;
    else text = `Hi ${m.name}, your ${pn} membership at ${gymName} ends on ${niceDate(m.expiry_date)} (${d} day${d === 1 ? '' : 's'} left). Renew soon!`;
    return text;
  };
  const sendReminder = (m: Member) => {
  openWhatsAppChat(m.phone, reminderText(m));
};
  // opens WhatsApp with the message ready to send (Indian numbers)
  const whatsappTo = (phone: string, text: string) => {
    Linking.openURL(`https://wa.me/91${digits10(phone)}?text=${encodeURIComponent(text)}`).catch(() => {
      Alert.alert('Could not open WhatsApp', 'Make sure WhatsApp is installed on this phone.');
    });
  };

  const checkInMember = (m: Member) => {
    if (activeBranch === 'all' && branches.length > 1) {
      Alert.alert('Choose a branch first', 'Tap a branch name at the top (not "All branches") so this visit is counted in the right branch.');
      return;
    }
    run(() => supabase.rpc('check_in', { p_member: m.id, p_branch: myBranchForActions }));
  };

    const deleteMember = (m: Member) => {
    Alert.alert(
      `Delete ${m.name}?`,
      'This removes the member and their attendance history. Payments stay in your money reports. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            const { data, error } = await supabase.from('members').delete().eq('id', m.id).select('id');
            setBusy(false);
            if (error) {
              Alert.alert('Could not delete', error.message);
              return;
            }
            if (!data || data.length === 0) {
              Alert.alert('Could not delete', 'You do not have permission to delete this member.');
              return;
            }
            setOverlay({ k: 'none' });
            await load();
          },
        },
      ]
    );
  };
  const collectPayment = async (memberId: string, method: 'cash' | 'upi') => {
    const ok = await run(() => supabase.rpc('collect_payment', { p_member: memberId, p_method: method }));
    if (ok) loadCollected();
  };
  const renew = (m: Member) => {
    const plan = planOf(m);
    if (!plan) return;
    const discount = Math.min(Number(m.credit), Number(plan.price));
    const pay = Number(plan.price) - discount;
    const expired = statusOf(m) === 'Expired';
    const justUnpaid = !m.paid && !expired;
    Alert.alert(
      justUnpaid ? `Mark ${m.name} as paid` : `Renew ${m.name}`,
      `${plan.name} plan: ${money(plan.price)}` + (discount ? `\nReferral credit used: -${money(discount)}` : '') + `\nCollect: ${money(pay)}`,
      [
        { text: 'Cancel', style: 'cancel' },
                { text: 'Received in cash', onPress: () => { collectPayment(m.id, 'cash'); } },
        { text: 'Received by UPI', onPress: () => { collectPayment(m.id, 'upi'); } },
      ]
    );
  };
  
  const freezeMember = (m: Member) => {
    if (statusOf(m) === 'Expired') {
      Alert.alert('Cannot freeze', 'This membership has already expired. Renew it first.');
      return;
    }
    const days = Math.floor(Number(freezeText));
    if (!freezeText.trim() || isNaN(days) || days < 1 || days > 365) {
      Alert.alert('Enter days', 'Type the number of days to freeze, from 1 to 365.');
      return;
    }
    Alert.alert(`Freeze ${m.name}?`, `The expiry date will move ${days} day${days === 1 ? '' : 's'} ahead.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Freeze',
        onPress: async () => {
          const ok = await run(() => supabase.rpc('freeze_member', { p_member: m.id, p_days: days }));
          if (ok) {
            setFreezeText('');
            Alert.alert('Frozen', `${m.name}'s expiry date moved ${days} days ahead.`);
            await load();
          }
        },
      },
    ]);
  };

    const exportMembers = async () => {
    const q = (v: string | number | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Name', 'Phone', 'Plan', 'Branch', 'Start date', 'Expiry date', 'Status', 'Fee paid', 'Referral credit', 'Referral code'];
    const rows = members.map((m) => [
      m.name,
      m.phone,
      planOf(m)?.name ?? '',
      branchName(m.home_branch_id),
      m.start_date,
      m.expiry_date,
      statusOf(m),
      m.paid ? 'Yes' : 'No',
      m.credit,
      m.referral_code,
    ]);
    const csv = [header, ...rows].map((r) => r.map(q).join(',')).join('\n');
    try {
      await Share.share({ title: `${gymName} members backup`, message: csv });
    } catch {
      Alert.alert('Could not share', 'Please try again.');
    }
  };
  const openAddMember = () => {
    setNRunning(false); setNDaysAgo(''); setNCount(true);
    setNName('');
    setNPhone('');
    setNPlan(plans[0]?.id ?? '');
    setNPaid(true);
    setNRef('');
    setNBranch(isOwner ? (activeBranch !== 'all' ? activeBranch : branches[0]?.id ?? '') : meNow.branch_id ?? '');
    setOverlay({ k: 'addMember' });
  };

  const addMember = async () => {
    if (!nName.trim() || digits10(nPhone).length !== 10) {
      Alert.alert('Check details', 'Enter the member name and a 10-digit phone number.');
      return;
    }
    if (!nPlan) {
      Alert.alert('Choose a plan', 'Add a plan in Manage first.');
      return;
    }
    const res = await runData(() =>
      supabase.rpc('add_member', {
        p_gym: gymId,
        p_name: nName.trim(),
        p_phone: digits10(nPhone),
        p_plan: nPlan,
        p_branch: nBranch || null,
        p_paid: nPaid,
        p_referral_code: nRef.trim() ? nRef.trim() : null,
p_start: nRunning ? startFromDaysAgo(nDaysAgo) : null,
p_count_payment: nRunning ? nCount : true,
      })
    );
    if (res) {
            if (nPaid) {
        const mid = (res as { member_id?: string }).member_id;
        if (mid) {
          await supabase.rpc('set_payment_method', { p_member: mid, p_method: payMethod });
          loadCollected();
        }
      }
      const code = (res as { invite_code?: string }).invite_code;
      setOverlay({ k: 'none' });
      if (code) showInvite(nName.trim(), code);
    }
  };

  const openAddStaff = () => {
    setSName('');
    setSPhone('');
    setSRole('receptionist');
    setSCanAdd(true);
    setSBranch(activeBranch !== 'all' ? activeBranch : branches[0]?.id ?? '');
    setOverlay({ k: 'addStaff' });
  };

  const addStaff = async () => {
    if (!sName.trim() || digits10(sPhone).length !== 10) {
      Alert.alert('Check details', 'Enter the staff name and a 10-digit phone number.');
      return;
    }
    const res = await runData(() =>
      supabase.rpc('add_staff', { p_gym: gymId, p_name: sName.trim(), p_phone: digits10(sPhone), p_role: sRole, p_branch: sBranch || null, p_can_add: sCanAdd })
    );
    if (res) {
      const code = (res as { invite_code?: string }).invite_code;
      setOverlay({ k: 'none' });
      if (code) showInvite(sName.trim(), code);
    }
  };

  const updateStaff = (id: string, patch: Partial<Staff>) => {
    run(() => supabase.from('staff').update(patch).eq('id', id));
  };

  const openBranch = (b: Branch | null) => {
    setBName(b ? b.name : '');
    setBArea(b ? b.area : '');
    setOverlay({ k: 'branch', id: b ? b.id : 'new' });
  };

  const saveBranch = async (id: string) => {
    if (!bName.trim()) {
      Alert.alert('Check details', 'Enter the branch name.');
      return;
    }
    const ok = await run(() =>
      id === 'new'
        ? supabase.from('branches').insert({ gym_id: gymId, name: bName.trim(), area: bArea.trim() })
        : supabase.from('branches').update({ name: bName.trim(), area: bArea.trim() }).eq('id', id)
    );
    if (ok) setOverlay({ k: 'none' });
  };

  const openPlan = (p: Plan | null) => {
    setPlName(p ? p.name : '');
    setPlDays(p ? String(p.days) : '');
    setPlPrice(p ? String(Math.round(Number(p.price))) : '');
    setOverlay({ k: 'plan', id: p ? p.id : 'new' });
  };

  const savePlan = async (id: string) => {
    const days = parseInt(plDays, 10);
    const price = Number(plPrice);
    if (!plName.trim() || !days || days <= 0 || isNaN(price) || price < 0) {
      Alert.alert('Check details', 'Enter a plan name, the number of days and a price.');
      return;
    }
    const ok = await run(() =>
      id === 'new'
        ? supabase.from('plans').insert({ gym_id: gymId, name: plName.trim(), days, price })
        : supabase.from('plans').update({ name: plName.trim(), days, price }).eq('id', id)
    );
    if (ok) setOverlay({ k: 'none' });
  };

  const saveReward = async () => {
    const n = Number(rewardText);
    if (isNaN(n) || n < 0) {
      Alert.alert('Check the amount', 'Enter the referral reward in rupees.');
      return;
    }
    const ok = await run(() => supabase.from('gyms').update({ referral_reward: n }).eq('id', gymId));
    if (ok) Alert.alert('Saved', 'Referral reward updated.');
  };

   const toggleCheckinMode = async (mode: string) => {
  const current = gym?.checkin_modes ?? ['tap'];
  const next = current.includes(mode) ? current.filter((x) => x !== mode) : [...current, mode];
  if (next.length === 0) {
    Alert.alert('Keep one option', 'Members need at least one way to check in.');
    return;
  }
  await run(() => supabase.rpc('set_checkin_modes', { p_gym: gymId, p_modes: next }));
};

  const addPost = async () => {
    if (!pTitle.trim() || !pBody.trim()) {
      Alert.alert('Check details', 'Write a title and a message.');
      return;
    }
    const branchId = isOwner ? (pAud === 'all' ? null : pAud) : meNow.branch_id;
    const res = await runData(() => supabase.from('posts').insert({ gym_id: gymId, branch_id: branchId, title: pTitle.trim(), body: pBody.trim() }).select('id').single());
    if (res) {
      
      setPTitle('');
      setPBody('');
    }
  };

  // ---------- header + branch bar ----------
  const header = (
    <>
      <Header title={gymName} sub={`${meNow.name}, ${ROLE_LABEL[meNow.role]}`} canSwitch={canSwitch} onSwitch={onSwitch} onSignOut={onSignOut} />
      {isOwner ? (
        <View style={s.scopeBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Chip label="All branches" on={scope === 'all'} onPress={() => setScope('all')} />
            {branches.map((b) => <Chip key={b.id} label={b.name} on={scope === b.id} onPress={() => setScope(b.id)} />)}
          </ScrollView>
        </View>
      ) : (
        <View style={[s.scopeBar, { paddingBottom: 8 }]}>
          <Text style={s.meta}>Branch: {branchName(meNow.branch_id)}</Text>
        </View>
      )}
    </>
  );

  const navItems: { key: Tab; label: string }[] = [
    { key: 'home', label: 'Home' },
    { key: 'members', label: 'Members' },
    { key: 'attendance', label: 'Attendance' },
    { key: 'news', label: 'News' },
  ];
  if (isOwner) navItems.push({ key: 'manage', label: 'Manage' });
  const nav = <Nav tab={tab} items={navItems} onChange={(t) => { setTab(t); setOverlay({ k: 'none' }); }} />;
  const shell = (content: React.ReactNode, withRefresh = false) => (
    <SafeAreaView style={s.screen}>
      {header}
      <Page onRefresh={withRefresh ? refresh : undefined} refreshing={refreshing}>{tab === 'home' && overlay.k === 'none' && isOwner ? <RenewalBanner gymId={gymId} /> : null}{content}{tab === 'home' && <AccountSection isOwner={isOwner} />}</Page>
      {nav}
    </SafeAreaView>
  );
  const saveBtn = (label: string, onPress: () => void) => (
    <Pressable style={[s.primaryBtn, busy && s.disabled]} disabled={busy} onPress={onPress}>
      <Text style={s.primaryBtnText}>{busy ? 'Please wait...' : label}</Text>
    </Pressable>
  );

  if (loading) return <Loading text="Loading your gym..." />;

  // ---------- overlays ----------
  if (overlay.k === 'liveQr') {
  return <LiveQrScreen gymId={gymId} branches={branches} onClose={() => setOverlay({ k: 'none' })} />;
}
if (overlay.k === 'staticQr') {
  return <StaticQrScreen gymId={gymId} branches={branches} onClose={() => setOverlay({ k: 'none' })} />;
}
  if (overlay.k === 'addMember' && canAdd) {
    return shell(
      <>
        <Pressable onPress={() => setOverlay({ k: 'none' })}><Text style={s.back}>Back to members</Text></Pressable>
        <Text style={s.title}>Add member</Text>
        <Text style={s.label}>Name</Text>
        <TextInput style={s.input} value={nName} onChangeText={setNName} placeholder="Member name" />
        <Text style={s.label}>Mobile number</Text>
        <TextInput style={s.input} value={nPhone} onChangeText={setNPhone} keyboardType="phone-pad" placeholder="10-digit number" />
        <Text style={s.label}>Branch</Text>
        {isOwner ? (
          <View style={s.chipRow}>{branches.map((b) => <Chip key={b.id} label={b.name} on={nBranch === b.id} onPress={() => setNBranch(b.id)} />)}</View>
        ) : (
          <Text style={[s.bio, { marginTop: 0, marginBottom: 12 }]}>{branchName(meNow.branch_id)}</Text>
        )}
        <Text style={s.label}>Plan</Text>
        <View style={s.chipRow}>{plans.map((p) => <Chip key={p.id} label={`${p.name} ${money(p.price)}`} on={nPlan === p.id} onPress={() => setNPlan(p.id)} />)}</View>
        <Text style={s.label}>Payment</Text>
        <View style={s.chipRow}>
          <Chip label="Paid" on={nPaid} onPress={() => setNPaid(true)} />
          <Chip label="Pending" on={!nPaid} onPress={() => setNPaid(false)} />
        </View>
                {nPaid && (
          <>
            <Text style={s.label}>Received by</Text>
            <View style={s.chipRow}>
              <Chip label="Cash" on={payMethod === 'cash'} onPress={() => setPayMethod('cash')} />
              <Chip label="UPI" on={payMethod === 'upi'} onPress={() => setPayMethod('upi')} />
            </View>
          </>
        )}
        <Text style={s.label}>Membership</Text>
<View style={s.chipRow}>
  <Chip label="New today" on={!nRunning} onPress={() => setNRunning(false)} />
  <Chip label="Already running" on={nRunning} onPress={() => setNRunning(true)} />
</View>
{nRunning && (
  <>
    <Text style={s.label}>Joined how many days ago?</Text>
    <TextInput style={s.input} value={nDaysAgo} onChangeText={setNDaysAgo} keyboardType="number-pad" placeholder="e.g. 10 (0 = today)" />
    {nPaid && (
      <>
        <Text style={s.label}>Payment record</Text>
        <View style={s.chipRow}>
          <Chip label="Paid earlier (not in reports)" on={!nCount} onPress={() => setNCount(false)} />
          <Chip label="Record payment now" on={nCount} onPress={() => setNCount(true)} />
        </View>
      </>
    )}
  </>
)}
<Text style={s.label}>Referral code (optional)</Text>
        <TextInput style={s.input} value={nRef} onChangeText={setNRef} autoCapitalize="characters" placeholder="Code of the member who referred" />
        {saveBtn('Save member', addMember)}
        <Text style={[s.meta, { marginTop: 10 }]}>After saving, you get an invite code to send to the member.</Text>
      </>
    );
  }

  if (overlay.k === 'member') {
    const m = members.find((x) => x.id === overlay.id);
    if (m) {
      const plan = planOf(m);
      const expired = statusOf(m) === 'Expired';
      const refBy = m.referred_by ? members.find((x) => x.id === m.referred_by) : undefined;
      return shell(
        <>
          <Pressable onPress={() => setOverlay({ k: 'none' })}><Text style={s.back}>Back to members</Text></Pressable>
          <Text style={s.title}>{m.name}</Text>
          <View style={{ flexDirection: 'row', marginBottom: 12 }}>{statusBadge(m)}</View>
          <View style={s.panel}>
            <Row label="Phone" value={m.phone} />
            <Row label="Home branch" value={branchName(m.home_branch_id)} />
            <Row label="Plan" value={plan ? (money_ ? `${plan.name} (${money(plan.price)})` : plan.name) : '-'} />
            <Row label="Started" value={niceDate(m.start_date)} />
            <Row label="Expires" value={`${niceDate(m.expiry_date)} (${reasonText(m)})`} />
            <Row label="Referral code" value={m.referral_code} />
            {money_ && <Row label="Referral credit" value={money(m.credit)} />}
            {refBy && <Row label="Referred by" value={refBy.name} />}
            <Row label="Account" value={m.user_id ? 'Signed in once' : 'Not signed in yet'} />
          </View>
                          {(me.role === 'owner' || me.role === 'manager') && (
          <Pressable
            style={[s.smallBtn, { backgroundColor: '#D32F2F', alignSelf: 'flex-start', marginBottom: 12 }]}
            onPress={() => deleteMember(m)}
          >
            <Text style={s.smallBtnText}>Delete member</Text>
          </Pressable>
        )}
                        {me.role === 'owner' && history && (
          <View style={{ marginBottom: 12 }}>
            <Text style={s.section}>History</Text>
            <View style={s.panel}>
              <Text style={s.meta}>
                Added by {history.added_by ?? 'unknown'} on {niceDate(toISO(new Date(history.added_on)))}
              </Text>
              {history.payments.length === 0 && <Text style={[s.meta, { marginTop: 4 }]}>No payments yet.</Text>}
              {history.payments.map((p, i) => (
                <Text key={i} style={[s.meta, { marginTop: 4 }]}>
                  {niceDate(p.day)}: {p.plan_name ?? 'Plan'}, {money(p.amount)}
                  {p.method ? `, ${p.method}` : ''}, collected by {p.by ?? 'unknown'}
                </Text>
              ))}
            </View>
          </View>
        )}
                {(me.role === 'owner' || me.role === 'manager') && (
          <View style={{ marginBottom: 12 }}>
            <Text style={s.section}>Freeze membership</Text>
            <TextInput
              style={s.input}
              placeholder="Days to freeze (e.g. 12)"
              keyboardType="numeric"
              value={freezeText}
              onChangeText={setFreezeText}
            />
            <Pressable
              style={[s.smallBtn, { alignSelf: 'flex-start', marginTop: 8 }]}
              onPress={() => freezeMember(m)}
            >
              <Text style={s.smallBtnText}>Freeze</Text>
            </Pressable>
          </View>
        )}
                    {(() => {
            const cy = Number(scMonth.slice(0, 4));
            const cm = Number(scMonth.slice(5, 7));
            const dim = new Date(cy, cm, 0).getDate();
            const firstWd = new Date(cy, cm - 1, 1).getDay();
            const cells: (number | null)[] = [];
            for (let i = 0; i < firstWd; i++) cells.push(null);
            for (let n = 1; n <= dim; n++) cells.push(n);
            while (cells.length % 7 !== 0) cells.push(null);
            const isoOf = (n: number) => `${scMonth}-${pad(n)}`;
            const statusAt = (n: number): 'present' | 'absent' | 'none' => {
              if (scDays.includes(isoOf(n))) return 'present';
              if (isoOf(n) >= m.start_date && isoOf(n) < today) return 'absent';
              return 'none';
            };
            let present = 0;
            let absent = 0;
            for (let n = 1; n <= dim; n++) {
              const st = statusAt(n);
              if (st === 'present') present++;
              if (st === 'absent') absent++;
            }
            const shift = (delta: number) => {
              const d = new Date(cy, cm - 1 + delta, 1);
              setScMonth(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
            };
            return (
              <View style={s.panel}>
                <Text style={s.cardName}>Attendance calendar</Text>
                <View style={[s.row, { marginTop: 6 }]}>
                  <Pressable onPress={() => shift(-1)}><Text style={s.switchText}>Prev</Text></Pressable>
                  <Text style={s.cardName}>{MONTHS[cm - 1]} {cy}</Text>
                  <Pressable onPress={() => shift(1)}><Text style={s.switchText}>Next</Text></Pressable>
                </View>
                <View style={{ flexDirection: 'row', marginTop: 10 }}>
                  {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => (
                    <Text key={i} style={[s.meta, { width: '14.2857%', textAlign: 'center' }]}>{w}</Text>
                  ))}
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                  {cells.map((n, i) => {
                    const st = n ? statusAt(n) : 'none';
                    return (
                      <View key={i} style={{ width: '14.2857%', alignItems: 'center', paddingVertical: 4 }}>
                        {n ? (
                          <View
                            style={{
                              width: 34,
                              height: 34,
                              borderRadius: 17,
                              alignItems: 'center',
                              justifyContent: 'center',
                              borderWidth: isoOf(n) === today ? 2 : 0,
                              borderColor: '#111827',
                              backgroundColor: st === 'present' ? '#16A34A' : st === 'absent' ? '#DC2626' : '#F3F4F6',
                            }}
                          >
                            <Text style={{ fontWeight: '700', color: st === 'none' ? '#6B7280' : '#FFFFFF' }}>{n}</Text>
                          </View>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
                <Text style={[s.cardName, { marginTop: 10 }]}>Present {present} days | Absent {absent} days</Text>
                <Text style={s.meta}>Green: checked in. Red: did not check in. Grey: today, future, or before joining.</Text>
              </View>
            );
          })()}
          {!m.user_id && canAdd && (() => {
            const inv = inviteFor('member', m.id);
            return (
              <View style={s.panel}>
                <Text style={s.cardName}>Invite to the app</Text>
                {inv ? (
                  <>
                    <Text style={s.inviteCode}>{fmtCode(inv.code)}</Text>
                    <Text style={s.meta}>Works once. Expires {niceDate(inv.expires_at)}.</Text>
                    <View style={[s.row, { marginTop: 10, gap: 10 }]}>
                      <Pressable style={[s.halfBtn, { backgroundColor: PRIMARY }]} onPress={() => shareInvite(inv.code)}><Text style={s.smallBtnText}>Share invite</Text></Pressable>
                      <Pressable style={[s.halfBtn, { backgroundColor: '#E5E7EB' }]} onPress={() => newInvite('member', m.id, m.name)}><Text style={[s.smallBtnText, { color: INK }]}>New code</Text></Pressable>
                    </View>
                  </>
                ) : (
                  <Pressable style={[s.secondaryBtn, { marginTop: 10 }]} onPress={() => newInvite('member', m.id, m.name)}><Text style={s.secondaryBtnText}>Create invite code</Text></Pressable>
                )}
              </View>
            );
          })()}
          {money_ && (
            <>
              {saveBtn(!m.paid && !expired ? 'Mark paid' : 'Renew membership', () => renew(m))}
              <Pressable style={s.secondaryBtn} onPress={() => sendReminder(m)}><Text style={s.secondaryBtnText}>Send reminder</Text></Pressable>
            </>
          )}
          <Pressable style={[s.secondaryBtn, busy && s.disabled]} disabled={busy} onPress={() => checkInMember(m)}>
            <Text style={s.secondaryBtnText}>{checkedToday(m.id) ? 'Checked in today' : 'Check in today'}</Text>
          </Pressable>
          

        </>
      );
    }
  }

  if (isOwner && overlay.k === 'addStaff') {
    return shell(
      <>
        <Pressable onPress={() => setOverlay({ k: 'none' })}><Text style={s.back}>Back to staff</Text></Pressable>
        <Text style={s.title}>Add staff</Text>
        <Text style={s.label}>Name</Text>
        <TextInput style={s.input} value={sName} onChangeText={setSName} placeholder="Staff name" />
        <Text style={s.label}>Mobile number</Text>
        <TextInput style={s.input} value={sPhone} onChangeText={setSPhone} keyboardType="phone-pad" placeholder="10-digit number" />
        <Text style={s.label}>Role</Text>
        <View style={s.chipRow}>
          {EDITABLE_ROLES.map((r) => <Chip key={r} label={ROLE_LABEL[r]} on={sRole === r} onPress={() => { setSRole(r); setSCanAdd(r !== 'trainer'); }} />)}
        </View>
        <Text style={[s.meta, { marginBottom: 12 }]}>{ROLE_INFO[sRole]}</Text>
        <Text style={s.label}>Allowed to add members?</Text>
        <View style={s.chipRow}>
          <Chip label="Yes" on={sCanAdd} onPress={() => setSCanAdd(true)} />
          <Chip label="No" on={!sCanAdd} onPress={() => setSCanAdd(false)} />
        </View>
        <Text style={s.label}>Branch</Text>
        <View style={s.chipRow}>{branches.map((b) => <Chip key={b.id} label={b.name} on={sBranch === b.id} onPress={() => setSBranch(b.id)} />)}</View>
        {saveBtn('Save staff', addStaff)}
        <Text style={[s.meta, { marginTop: 10 }]}>After saving, you get an invite code to send to them.</Text>
      </>
    );
  }

  if (isOwner && overlay.k === 'staff') {
    const x = staff.find((r) => r.id === overlay.id);
    if (x) {
      const isMe = x.user_id === userId;
      return shell(
        <>
          <Pressable onPress={() => setOverlay({ k: 'none' })}><Text style={s.back}>Back to staff</Text></Pressable>
          <Text style={s.title}>{x.name}</Text>
          <View style={{ flexDirection: 'row', marginBottom: 12 }}>
            <Badge text={x.active ? 'Active' : 'Inactive'} kind={x.active ? 'good' : 'bad'} />
          </View>
          <View style={s.panel}>
            <Row label="Phone" value={x.phone ?? '-'} />
            <Row label="Role" value={ROLE_LABEL[x.role]} />
            <Row label="Branch" value={branchName(x.branch_id)} />
            <Row label="Can add members" value={x.role === 'owner' || x.can_add_members ? 'Yes' : 'No'} />
            <Row label="Account" value={x.user_id ? 'Signed in once' : 'Not signed in yet'} />
          </View>
          {!x.user_id && (() => {
            const inv = inviteFor('staff', x.id);
            return (
              <View style={s.panel}>
                <Text style={s.cardName}>Invite to the app</Text>
                {inv ? (
                  <>
                    <Text style={s.inviteCode}>{fmtCode(inv.code)}</Text>
                    <Text style={s.meta}>Works once. Expires {niceDate(inv.expires_at)}.</Text>
                    <View style={[s.row, { marginTop: 10, gap: 10 }]}>
                      <Pressable style={[s.halfBtn, { backgroundColor: PRIMARY }]} onPress={() => shareInvite(inv.code)}><Text style={s.smallBtnText}>Share invite</Text></Pressable>
                      <Pressable style={[s.halfBtn, { backgroundColor: '#E5E7EB' }]} onPress={() => newInvite('staff', x.id, x.name)}><Text style={[s.smallBtnText, { color: INK }]}>New code</Text></Pressable>
                    </View>
                  </>
                ) : (
                  <Pressable style={[s.secondaryBtn, { marginTop: 10 }]} onPress={() => newInvite('staff', x.id, x.name)}><Text style={s.secondaryBtnText}>Create invite code</Text></Pressable>
                )}
              </View>
            );
          })()}
          {isMe || x.role === 'owner' ? (
            <Text style={s.bio}>This is the owner account. It always has full access.</Text>
          ) : (
            <>
              <Text style={s.label}>Allowed to add members?</Text>
              <View style={s.chipRow}>
                <Chip label="Yes" on={x.can_add_members} onPress={() => updateStaff(x.id, { can_add_members: true })} />
                <Chip label="No" on={!x.can_add_members} onPress={() => updateStaff(x.id, { can_add_members: false })} />
              </View>
              <Text style={s.label}>Role</Text>
              <View style={s.chipRow}>
                {EDITABLE_ROLES.map((r) => <Chip key={r} label={ROLE_LABEL[r]} on={x.role === r} onPress={() => updateStaff(x.id, { role: r })} />)}
              </View>
              <Text style={[s.meta, { marginBottom: 12 }]}>{ROLE_INFO[x.role]}</Text>
              <Text style={s.label}>Branch</Text>
              <View style={s.chipRow}>
                {branches.map((b) => <Chip key={b.id} label={b.name} on={x.branch_id === b.id} onPress={() => updateStaff(x.id, { branch_id: b.id })} />)}
              </View>
              <Pressable style={[s.secondaryBtn, busy && s.disabled]} disabled={busy} onPress={() => updateStaff(x.id, { active: !x.active })}>
                <Text style={s.secondaryBtnText}>{x.active ? 'Deactivate staff' : 'Reactivate staff'}</Text>
              </Pressable>
            </>
          )}
        </>
      );
    }
  }

  if (isOwner && overlay.k === 'branch') {
    const id = overlay.id;
    return shell(
      <>
        <Pressable onPress={() => setOverlay({ k: 'none' })}><Text style={s.back}>Back to branches</Text></Pressable>
        <Text style={s.title}>{id === 'new' ? 'Add branch' : 'Edit branch'}</Text>
        <Text style={s.label}>Branch name</Text>
        <TextInput style={s.input} value={bName} onChangeText={setBName} placeholder="For example, Madhapur" />
        <Text style={s.label}>Area or address</Text>
        <TextInput style={s.input} value={bArea} onChangeText={setBArea} placeholder="Landmark or street" />
        {saveBtn('Save branch', () => saveBranch(id))}
      </>
    );
  }

  if (isOwner && overlay.k === 'plan') {
    const id = overlay.id;
    return shell(
      <>
        <Pressable onPress={() => setOverlay({ k: 'none' })}><Text style={s.back}>Back to plans</Text></Pressable>
        <Text style={s.title}>{id === 'new' ? 'Add plan' : 'Edit plan'}</Text>
        <Text style={s.label}>Plan name</Text>
        <TextInput style={s.input} value={plName} onChangeText={setPlName} placeholder="For example, Monthly" />
        <Text style={s.label}>Number of days</Text>
        <TextInput style={s.input} value={plDays} onChangeText={setPlDays} keyboardType="numeric" placeholder="30" />
        <Text style={s.label}>Price (₹)</Text>
        <TextInput style={s.input} value={plPrice} onChangeText={setPlPrice} keyboardType="numeric" placeholder="1000" />
        {saveBtn('Save plan', () => savePlan(id))}
      </>
    );
  }

  // ---------- Manage (owner) ----------
  if (isOwner && tab === 'manage') {
    const staffList = staff.filter((x) => inScope(x.branch_id));
    return shell(
      <>
        <View style={s.chipRow}>
          <Chip label="Staff" on={manageTab === 'staff'} onPress={() => setManageTab('staff')} />
          <Chip label="Branches" on={manageTab === 'branches'} onPress={() => setManageTab('branches')} />
          <Chip label="Plans" on={manageTab === 'plans'} onPress={() => { setManageTab('plans'); setRewardText(String(Math.round(Number(gym?.referral_reward ?? 0)))); }} />
                    <Chip label="Money" on={manageTab === 'money'} onPress={() => setManageTab('money')} />
          <Chip label="Reports" on={manageTab === 'reports'} onPress={() => setManageTab('reports')} />
        </View>
        {manageTab === 'staff' && (
          <>
            <View style={s.row}>
              <Text style={s.title}>Staff ({staffList.length})</Text>
              <Pressable style={s.smallBtn} onPress={openAddStaff}><Text style={s.smallBtnText}>+ Add</Text></Pressable>
            </View>
            {staffList.map((x) => (
              <Pressable key={x.id} style={s.card} onPress={() => setOverlay({ k: 'staff', id: x.id })}>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardName}>{x.name}</Text>
                  <Text style={s.meta}>{ROLE_LABEL[x.role]} | {branchName(x.branch_id)}{x.role !== 'owner' && x.can_add_members ? ' | can add members' : ''}</Text>
                </View>
                <Badge text={x.active ? 'Active' : 'Inactive'} kind={x.active ? 'good' : 'bad'} />
              </Pressable>
            ))}
          </>
        )}
        {manageTab === 'branches' && (
          <>
            <View style={s.row}>
              <Text style={s.title}>Branches ({branches.length})</Text>
              <Pressable style={s.smallBtn} onPress={() => openBranch(null)}><Text style={s.smallBtnText}>+ Add</Text></Pressable>
            </View>
            {branches.map((b) => {
              const ms = members.filter((x) => x.home_branch_id === b.id);
              const st = staff.filter((x) => x.branch_id === b.id && x.active);
              return (
                <Pressable key={b.id} style={s.panel} onPress={() => openBranch(b)}>
                  <Text style={s.cardName}>{b.name}</Text>
                  {!!b.area && <Text style={s.meta}>{b.area}</Text>}
                  <Text style={s.meta}>{ms.length} members | {st.length} staff | {ms.filter(feeDue).length} fees due</Text>
                </Pressable>
              );
            })}
          </>
        )}
                {manageTab === 'money' && (
          <>
            <Text style={s.title}>Money collected</Text>
            <View style={s.chipRow}>
              <Chip label="Daily" on={period === 'day'} onPress={() => setPeriod('day')} />
              <Chip label="Weekly" on={period === 'week'} onPress={() => setPeriod('week')} />
              <Chip label="Monthly" on={period === 'month'} onPress={() => setPeriod('month')} />
            </View>
            <View style={s.pendingCard}>
              <Text style={s.pendingLabel}>
                {period === 'day' ? 'Last 30 days' : period === 'week' ? 'Last 12 weeks' : 'Last 12 months'}
                {scope === 'all' ? ' | all branches' : ` | ${branchName(scope)}`}
              </Text>
              <Text style={s.pendingValue}>{money(report.reduce((sum, r) => sum + Number(r.total), 0))}</Text>
            </View>
            <Text style={s.section}>
              {period === 'day' ? 'Day by day' : period === 'week' ? 'Week by week' : 'Month by month'}
            </Text>
            {report.length === 0 && (
              <Text style={s.empty}>No payments recorded yet. They appear when you add a paid member, renew, or mark a member as paid.</Text>
            )}
            {report.map((r) => (
              <View key={r.bucket} style={s.card}>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardName}>
                    {period === 'month'
                      ? `${MONTHS[fromISO(r.bucket).getMonth()]} ${fromISO(r.bucket).getFullYear()}`
                      : period === 'week'
                      ? `Week of ${niceDate(r.bucket)}`
                      : niceDate(r.bucket)}
                  </Text>
                  <Text style={s.meta}>{r.cnt} payment{Number(r.cnt) === 1 ? '' : 's'}</Text>
                </View>
                <Text style={s.price}>{money(r.total)}</Text>
              </View>
            ))}
          </>
        )}
        {manageTab === 'reports' && (() => {
          const where = scope === 'all' ? 'All branches' : branchName(scope);
          // revenue (from the server)
          const revList = (revRows ?? []).filter((r) => scope === 'all' || r.branch_id === scope);
          const revMonthList = Array.from(new Set(revList.map((r) => r.month_start)));
          // expiring (from the members already loaded)
          const lo = expRange === 'expired' ? -30 : 0;
          const hi = expRange === 'expired' ? -1 : Number(expRange);
          const lastVisit: Record<string, string> = {};
          checkins.forEach((c) => {
            if (!lastVisit[c.member_id] || c.day > lastVisit[c.member_id]) lastVisit[c.member_id] = c.day;
          });
          const expList = scopedMembers
            .filter((m) => {
              const d = daysLeft(m);
              return d >= lo && d <= hi;
            })
            .sort((a, b) => daysLeft(a) - daysLeft(b));
          const atStake = expList.reduce((sum, m) => sum + Number(planOf(m)?.price ?? 0), 0);
          return (
            <>
              <Text style={s.title}>Reports</Text>
              <View style={s.chipRow}>
                <Chip label="Revenue" on={repTab === 'revenue'} onPress={() => setRepTab('revenue')} />
                <Chip label="Expiring" on={repTab === 'expiring'} onPress={() => setRepTab('expiring')} />
                <Chip label="Attendance" on={repTab === 'attendance'} onPress={() => setRepTab('attendance')} />
              </View>
              <Text style={[s.meta, { marginBottom: 12 }]}>Showing: {where}</Text>

              {repTab === 'revenue' && (
                <>
                  <View style={s.chipRow}>
                    {[3, 6, 12].map((n) => (
                      <Chip key={n} label={`${n} months`} on={revMonths === n} onPress={() => setRevMonths(n)} />
                    ))}
                  </View>
                  <Text style={[s.meta, { marginBottom: 8 }]}>Money actually collected. Referral credit used is not counted.</Text>
                  {revRows === null && <Text style={s.empty}>Loading...</Text>}
                  {revRows !== null && revMonthList.length === 0 && <Text style={s.empty}>No payments in this period.</Text>}
                  {revMonthList.map((mo) => {
                    const list = revList.filter((r) => r.month_start === mo);
                    const total = list.reduce((a, r) => a + Number(r.total), 0);
                    const cnt = list.reduce((a, r) => a + Number(r.cnt), 0);
                    const cash = list.reduce((a, r) => a + Number(r.cash), 0);
                    const upi = list.reduce((a, r) => a + Number(r.upi), 0);
                    return (
                      <View key={mo} style={s.panel}>
                        <View style={s.row}>
                          <Text style={s.cardName}>{monthLabel(mo)}</Text>
                          <Text style={s.price}>{money(total)}</Text>
                        </View>
                        <Text style={s.meta}>
                          {cnt} payment{cnt === 1 ? '' : 's'} | Cash {money(cash)} | UPI {money(upi)}
                        </Text>
                        {scope === 'all' && branches.length > 1 && (
                          <View style={{ marginTop: 8 }}>
                            {list.map((r) => (
                              <Row key={String(r.branch_id)} label={r.branch_name} value={`${money(r.total)} (${r.cnt})`} />
                            ))}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </>
              )}

              {repTab === 'expiring' && (
                <>
                  <View style={s.chipRow}>
                    <Chip label="Expired (30 days)" on={expRange === 'expired'} onPress={() => setExpRange('expired')} />
                    <Chip label="Next 7 days" on={expRange === '7'} onPress={() => setExpRange('7')} />
                    <Chip label="Next 15 days" on={expRange === '15'} onPress={() => setExpRange('15')} />
                    <Chip label="Next 30 days" on={expRange === '30'} onPress={() => setExpRange('30')} />
                  </View>
                  <View style={s.pendingCard}>
                    <Text style={s.pendingLabel}>
                      {expList.length} member{expList.length === 1 ? '' : 's'} | plan value
                    </Text>
                    <Text style={s.pendingValue}>{money(atStake)}</Text>
                  </View>
                  {expList.length === 0 && <Text style={[s.empty, { marginTop: 10 }]}>No members in this range.</Text>}
                  {expList.map((m) => (
                    <View key={m.id} style={[s.panel, { marginTop: 10 }]}>
                      <View style={s.row}>
                        <Text style={s.cardName}>{m.name}</Text>
                        {statusBadge(m)}
                      </View>
                      <Text style={s.meta}>
                        {planOf(m)?.name ?? ''} plan | {niceDate(m.expiry_date)} ({reasonText(m)})
                        {scope === 'all' ? ` | ${branchName(m.home_branch_id)}` : ''}
                      </Text>
                      <Text style={s.meta}>
                        {lastVisit[m.id] ? `Last visit ${niceDate(lastVisit[m.id])}` : 'No visit in the last 30 days'}
                      </Text>
                      <View style={[s.row, { marginTop: 10, gap: 10 }]}>
                        <Pressable style={[s.halfBtn, { backgroundColor: '#E5E7EB' }]} onPress={() => whatsappTo(m.phone, reminderText(m))}>
                          <Text style={[s.smallBtnText, { color: INK }]}>WhatsApp</Text>
                        </Pressable>
                        <Pressable style={[s.halfBtn, { backgroundColor: PRIMARY }]} onPress={() => renew(m)}>
                          <Text style={s.smallBtnText}>{!m.paid && statusOf(m) !== 'Expired' ? 'Mark paid' : 'Renew'}</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </>
              )}

              {repTab === 'attendance' && (
                <>
                  <View style={s.chipRow}>
                    {[7, 30, 90].map((n) => (
                      <Chip key={n} label={`${n} days`} on={attDays === n} onPress={() => setAttDays(n)} />
                    ))}
                  </View>
                  {!attReport && <Text style={s.empty}>Loading...</Text>}
                  {attReport && (() => {
                    const maxH = Math.max(1, ...attReport.by_hour.map((h) => Number(h.visits)));
                    const topHours = [...attReport.by_hour].sort((a, b) => Number(b.visits) - Number(a.visits)).slice(0, 5);
                    return (
                      <>
                        <View style={s.statGrid}>
                          <Stat label="Visits" value={attReport.total} />
                          <Stat label="Different members" value={attReport.members} />
                          <Stat label="Average visits per day" value={attReport.avg_per_day} />
                          <Stat label="Not seen for 14+ days" value={attReport.inactive.length} />
                        </View>
                        {scope === 'all' && attReport.by_branch.length > 0 && (
                          <>
                            <Text style={s.section}>By branch</Text>
                            <View style={s.panel}>
                              {attReport.by_branch.map((b) => (
                                <Row key={String(b.branch_id)} label={b.name} value={`${b.visits} visits, ${b.members} members`} />
                              ))}
                            </View>
                          </>
                        )}
                        <Text style={s.section}>Busiest hours</Text>
                        {topHours.length === 0 ? (
                          <Text style={s.empty}>No check-ins in this period.</Text>
                        ) : (
                          <View style={s.panel}>
                            {topHours.map((h) => (
                              <View key={h.hour} style={{ marginBottom: 8 }}>
                                <View style={s.row}>
                                  <Text style={s.rowLabel}>{hourLabel(h.hour)}</Text>
                                  <Text style={s.rowValue}>{h.visits} visits</Text>
                                </View>
                                <View style={{ height: 6, borderRadius: 3, backgroundColor: '#E5E7EB' }}>
                                  <View style={{ height: 6, borderRadius: 3, backgroundColor: PRIMARY, width: `${Math.round((Number(h.visits) / maxH) * 100)}%` }} />
                                </View>
                              </View>
                            ))}
                          </View>
                        )}
                                                <Text style={s.section}>Busiest days of the week</Text>
                        {(() => {
                          const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                          const byDow: Record<number, number> = {};
                          dowRows.forEach((r) => { byDow[Number(r.dow)] = Number(r.cnt); });
                          const maxD = Math.max(1, ...DOW.map((_, i) => byDow[i] ?? 0));
                          const totalD = DOW.reduce((a, _, i) => a + (byDow[i] ?? 0), 0);
                          if (totalD === 0) return <Text style={s.empty}>No check-ins in this period.</Text>;
                          return (
                            <View style={s.panel}>
                              {DOW.map((d, i) => (
                                <View key={d} style={{ marginBottom: 8 }}>
                                  <View style={s.row}>
                                    <Text style={s.rowLabel}>{d}</Text>
                                    <Text style={s.rowValue}>{byDow[i] ?? 0} visits</Text>
                                  </View>
                                  <View style={{ height: 6, borderRadius: 3, backgroundColor: '#E5E7EB' }}>
                                    <View style={{ height: 6, borderRadius: 3, backgroundColor: PRIMARY, width: `${Math.round(((byDow[i] ?? 0) / maxD) * 100)}%` }} />
                                  </View>
                                </View>
                              ))}
                            </View>
                          );
                        })()}
                        <Text style={s.section}>Not visited for 14+ days</Text>
                        <Text style={[s.meta, { marginBottom: 8 }]}>Members with a valid plan who have not checked in for two weeks. A message now can bring them back.</Text>
                        {attReport.inactive.length === 0 && <Text style={s.empty}>Everyone has visited recently.</Text>}
                        {attReport.inactive.map((i) => (
                          <View key={i.member_id} style={s.panel}>
                            <Text style={s.cardName}>{i.name}</Text>
                            <Text style={s.meta}>
                              {i.last_visit ? `Last visit ${niceDate(i.last_visit)}` : 'Never checked in'} | Plan valid till {niceDate(i.expiry_date)}
                            </Text>
                            <Pressable
                              style={[s.secondaryBtn, { marginTop: 10 }]}
                              onPress={() =>
                                whatsappTo(i.phone, `Hi ${i.name}, we have not seen you at ${gymName} for a while. Your membership is valid till ${niceDate(i.expiry_date)}. Come in for a workout this week!`)
                              }
                            >
                              <Text style={s.secondaryBtnText}>WhatsApp</Text>
                            </Pressable>
                          </View>
                        ))}
                      </>
                    );
                  })()}
                </>
              )}
            </>
          );
        })()}
        {manageTab === 'plans' && (
          <>
            <View style={s.row}>
              <Text style={s.title}>Plans ({plans.length})</Text>
              <Pressable style={s.smallBtn} onPress={() => openPlan(null)}><Text style={s.smallBtnText}>+ Add</Text></Pressable>
            </View>
            {plans.map((p) => (
              <Pressable key={p.id} style={s.card} onPress={() => openPlan(p)}>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardName}>{p.name}</Text>
                  <Text style={s.meta}>{p.days} days</Text>
                </View>
                <Text style={s.price}>{money(p.price)}</Text>
              </Pressable>
            ))}
            <Text style={s.section}>Referral reward</Text>
            <Text style={s.meta}>Credit a member earns when a friend they referred joins and pays.</Text>
            <TextInput style={[s.input, { marginTop: 8 }]} keyboardType="numeric" value={rewardText} onChangeText={setRewardText} placeholder="200" />
            {saveBtn('Save reward', saveReward)}
            {isOwner && (
  <>
    <Text style={s.section}>Check-in methods</Text>
    <Text style={s.meta}>Choose how members can check in. Tick one or more.</Text>
    <View style={s.chipRow}>
      <Chip label="Tap" on={(gym?.checkin_modes ?? ['tap']).includes('tap')} onPress={() => toggleCheckinMode('tap')} />
      <Chip label="Live QR" on={(gym?.checkin_modes ?? ['tap']).includes('live_qr')} onPress={() => toggleCheckinMode('live_qr')} />
      <Chip label="Printed QR + location" on={(gym?.checkin_modes ?? ['tap']).includes('static_qr')} onPress={() => toggleCheckinMode('static_qr')} />
    </View>
    {(gym?.checkin_modes ?? ['tap']).includes('live_qr') && (
  <Pressable style={[s.smallBtn, { alignSelf: 'flex-start', marginTop: 10 }]} onPress={() => setOverlay({ k: 'liveQr' })}>
    <Text style={s.smallBtnText}>Show check-in QR</Text>
  </Pressable>
)}
{(gym?.checkin_modes ?? ['tap']).includes('static_qr') && (
  <Pressable style={[s.smallBtn, { alignSelf: 'flex-start', marginTop: 10 }]} onPress={() => setOverlay({ k: 'staticQr' })}>
    <Text style={s.smallBtnText}>Show printed QR and set location</Text>
  </Pressable>
)}
  </>
)}
          </>
        )}
      </>,
      true
    );
  }

  // ---------- Members ----------
  if (tab === 'members') {
    const filterFn = (x: Member) =>
  memberFilter === 'all' ? true
  : memberFilter === 'active' ? statusOf(x) !== 'Expired'
  : memberFilter === 'expiring' ? statusOf(x) === 'Expiring'
  : memberFilter === 'due' ? feeDue(x)
  : todays.some((c) => c.member_id === x.id);
const list = scopedMembers.filter(filterFn).filter((x) => x.name.toLowerCase().includes(search.toLowerCase()) || x.phone.includes(search));
    return shell(
      <>
        <View style={s.row}>
          <Text style={s.title}>Members ({scopedMembers.length})</Text>
          {canAdd && <Pressable style={s.smallBtn} onPress={openAddMember}><Text style={s.smallBtnText}>+ Add</Text></Pressable>}
        </View>
        <TextInput style={s.input} placeholder="Search by name or number" value={search} onChangeText={setSearch} />
        {memberFilter !== 'all' && (
  <Pressable onPress={() => setMemberFilter('all')} style={[s.smallBtn, { alignSelf: 'flex-start', marginBottom: 12 }]}>
    <Text style={s.smallBtnText}>
      Showing: {{ active: 'Active members', expiring: 'Expiring in 7 days', due: 'Fees due', today: 'Checked in today' }[memberFilter]} ({list.length}). Tap to clear
    </Text>
  </Pressable>
)}
                {isOwner && (
          <Pressable style={[s.smallBtn, { alignSelf: 'flex-start', marginBottom: 12 }]} onPress={exportMembers}>
            <Text style={s.smallBtnText}>Export members backup</Text>
          </Pressable>
        )}
        {list.length === 0 && <Text style={s.empty}>{members.length === 0 ? 'No members yet. Tap + Add to add your first member.' : 'No members match.'}</Text>}
        {list.map((m) => (
          <Pressable key={m.id} style={s.card} onPress={() => setOverlay({ k: 'member', id: m.id })}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardName}>{m.name}</Text>
              <Text style={s.meta}>{planOf(m)?.name ?? ''} plan, {reasonText(m)}{activeBranch === 'all' ? ` | ${branchName(m.home_branch_id)}` : ''}</Text>
            </View>
            {statusBadge(m)}
          </Pressable>
        ))}
      </>,
      true
    );
  }

  // ---------- Attendance ----------
  if (tab === 'attendance') {
    const q = search.toLowerCase();
    const pickList = members.filter((m) => !q || m.name.toLowerCase().includes(q)).slice(0, 40);
    return shell(
      <>
        <Text style={s.title}>Attendance</Text>
        <Text style={[s.meta, { marginBottom: 12 }]}>{todays.length} checked in today, {niceDate(today)}</Text>
        {todays.length === 0 && <Text style={s.empty}>No check-ins yet today.</Text>}
        {todays.map((c) => {
          const m = members.find((x) => x.id === c.member_id);
          const visiting = m && m.home_branch_id !== c.branch_id;
          return (
            <View key={c.id} style={s.card}>
              <View style={{ flex: 1 }}>
                <Text style={s.cardName}>{memberName(c.member_id)}</Text>
                <Text style={s.meta}>In at {timeOf(c.checked_in_at)}{activeBranch === 'all' ? ` | ${branchName(c.branch_id)}` : ''}{visiting && m ? ` | visiting from ${branchName(m.home_branch_id)}` : ''}</Text>
              </View>
              <Badge text="Checked in" kind="good" />
            </View>
          );
        })}
        <Text style={s.section}>Mark attendance</Text>
        <TextInput style={s.input} placeholder="Search member" value={search} onChangeText={setSearch} />
        {pickList.map((m) => (
          <View key={m.id} style={s.card}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardName}>{m.name}</Text>
              <Text style={s.meta}>{reasonText(m)} | {branchName(m.home_branch_id)}</Text>
            </View>
            {checkedToday(m.id) ? (
              <Badge text="In today" kind="good" />
            ) : (
              <Pressable style={[s.smallBtn, busy && s.disabled]} disabled={busy} onPress={() => checkInMember(m)}><Text style={s.smallBtnText}>Check in</Text></Pressable>
            )}
          </View>
        ))}
      </>,
      true
    );
  }

  // ---------- News ----------
  if (tab === 'news') {
    const list = posts.filter((p) => p.branch_id === null || activeBranch === 'all' || p.branch_id === activeBranch);
    return shell(
      <>
        <Text style={s.title}>Announcements</Text>
        {canPost && (
          <>
            {isOwner && (
              <>
                <Text style={s.label}>Send to</Text>
                <View style={s.chipRow}>
                  <Chip label="All branches" on={pAud === 'all'} onPress={() => setPAud('all')} />
                  {branches.map((b) => <Chip key={b.id} label={b.name} on={pAud === b.id} onPress={() => setPAud(b.id)} />)}
                </View>
              </>
            )}
            <TextInput style={s.input} placeholder="Title" value={pTitle} onChangeText={setPTitle} />
            <TextInput style={[s.input, { height: 80, textAlignVertical: 'top' }]} multiline placeholder="Message for members" value={pBody} onChangeText={setPBody} />
            <View style={{ marginBottom: 16 }}>{saveBtn('Post announcement', addPost)}</View>
          </>
        )}
        {list.length === 0 && <Text style={s.empty}>No announcements yet.</Text>}
        {list.map((p) => (
          <View key={p.id} style={s.panel}>
            <Text style={s.cardName}>{p.title}</Text>
            <Text style={s.meta}>{niceDate(p.created_at)} | {branchName(p.branch_id)}</Text>
            <Text style={s.bio}>{p.body}</Text>
          </View>
        ))}
      </>,
      true
    );
  }

  // ---------- Home ----------
  const activeCount = scopedMembers.filter((m) => statusOf(m) !== 'Expired').length;
  const expiringCount = scopedMembers.filter((m) => statusOf(m) === 'Expiring').length;
  const dueMembers = scopedMembers.filter(feeDue);
  const pending = dueMembers.reduce((sum, m) => sum + Number(planOf(m)?.price ?? 0), 0);
  const attention = scopedMembers.filter((m) => statusOf(m) !== 'Active' || !m.paid).sort((a, b) => daysLeft(a) - daysLeft(b));
  return shell(
    <>
      <Text style={s.title}>Today</Text>
      <View style={s.statGrid}>
        <Stat label="Active members" value={activeCount} onPress={() => { setMemberFilter('active'); setTab('members'); }} />
<Stat label="Expiring in 7 days" value={expiringCount} onPress={() => { setMemberFilter('expiring'); setTab('members'); }} />
<Stat label="Fees due" value={dueMembers.length} onPress={() => { setMemberFilter('due'); setTab('members'); }} />
<Stat label="Checked in today" value={todays.length} onPress={() => { setMemberFilter('today'); setTab('members'); }} />
      </View>
      {money_ && (
        <View style={s.pendingCard}>
          <Text style={s.pendingLabel}>Money pending</Text>
          <Text style={s.pendingValue}>{money(pending)}</Text>
        </View>
      )}
            {isOwner && (
        <View style={[s.panel, { marginTop: 10 }]}>
          <Text style={s.cardName}>Collected today</Text>
          <Text style={s.price}>{money(collected.reduce((sum, r) => sum + Number(r.total), 0))}</Text>
          <Text style={s.meta}>
            Cash {money(collected.find((r) => r.method === 'cash')?.total ?? 0)} | UPI {money(collected.find((r) => r.method === 'upi')?.total ?? 0)}
          </Text>
        </View>
      )}
      {isOwner && scope === 'all' && branches.length > 1 && (
        <>
          <Text style={s.section}>By branch</Text>
          <View style={s.panel}>
            {branches.map((b) => {
              const ms = members.filter((x) => x.home_branch_id === b.id);
              return <Row key={b.id} label={b.name} value={`${ms.length} members, ${ms.filter(feeDue).length} due`} />;
            })}
          </View>
        </>
      )}
      {members.length === 0 && (
        <View style={s.panel}>
          <Text style={s.cardName}>Add your first member</Text>
          <Text style={s.bio}>Go to Members and tap + Add. Members join the app with an invite code you send them.</Text>
        </View>
      )}
      <Text style={s.section}>Needs attention</Text>
      {attention.length === 0 && <Text style={s.empty}>Everyone is up to date.</Text>}
      {attention.map((m) => {
        const expired = statusOf(m) === 'Expired';
        return (
          <View key={m.id} style={s.panel}>
            <View style={s.row}>
              <Text style={s.cardName}>{m.name}</Text>
              {statusBadge(m)}
            </View>
            <Text style={s.meta}>{planOf(m)?.name ?? ''} plan, {reasonText(m)}{activeBranch === 'all' ? ` | ${branchName(m.home_branch_id)}` : ''}</Text>
            {money_ && (
              <View style={[s.row, { marginTop: 10, gap: 10 }]}>
                <Pressable style={[s.halfBtn, { backgroundColor: '#E5E7EB' }]} onPress={() => sendReminder(m)}>
                  <Text style={[s.smallBtnText, { color: INK }]}>Send reminder</Text>
                </Pressable>
                <Pressable style={[s.halfBtn, { backgroundColor: PRIMARY }]} onPress={() => renew(m)}>
                  <Text style={s.smallBtnText}>{!m.paid && !expired ? 'Mark paid' : 'Renew'}</Text>
                </Pressable>
              </View>
            )}
          </View>
        );
      })}
    </>,
    true
  );
}

// =====================================================================
//  MEMBER VIEW
// =====================================================================
function AccountSection({ isOwner }: { isOwner: boolean }) {
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

    const contactSupport = () => {
    if (!SUPPORT_WHATSAPP) {
      Alert.alert('Support', 'Support contact is not set up yet.');
      return;
    }
    Linking.openURL(`https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent('Hello, I need help with the GymKhata app.')}`).catch(() => {
      Alert.alert('Could not open WhatsApp', 'Make sure WhatsApp is installed on this phone.');
    });
  };

  const doDelete = async () => {
    setBusy(true);
    const { error } = await supabase.rpc('delete_my_account', { p_confirm: isOwner ? confirmText.trim() : null });
    setBusy(false);
    if (error) {
      Alert.alert('Could not delete account', error.message);
      return;
    }
    await supabase.auth.signOut({ scope: 'local' });
  };

  const askDelete = () => {
    if (isOwner && confirmText.trim() !== 'DELETE') {
      Alert.alert('Type DELETE', 'To delete your gym and account, type DELETE in capital letters in the box first.');
      return;
    }
    Alert.alert(
      isOwner ? 'Delete gym and account?' : 'Delete your account?',
      isOwner
        ? 'This permanently deletes your gym, all its members, plans, check-ins and payments, and your login. This cannot be undone.'
        : 'This permanently deletes your login and your membership details. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => { doDelete(); } },
      ]
    );
  };

  return (
    <View style={{ marginTop: 24, marginBottom: 24 }}>
      <Text style={s.section}>Help and account</Text>
      <Pressable style={[s.smallBtn, { alignSelf: 'flex-start', marginBottom: 12 }]} onPress={contactSupport}>
        <Text style={s.smallBtnText}>Contact support</Text>
      </Pressable>
      <Pressable onPress={() => setOpen(!open)}>
        <Text style={s.switchText}>{open ? 'Hide' : 'Delete my account'}</Text>
      </Pressable>
      {open && (
        <View style={{ marginTop: 8 }}>
          <Text style={s.meta}>
            {isOwner
              ? 'As the owner, this deletes your whole gym with all its members and payments, and your login.'
              : 'This deletes your login and your membership details.'}
          </Text>
          {isOwner && (
            <TextInput
              style={s.input}
              placeholder="Type DELETE"
              autoCapitalize="characters"
              value={confirmText}
              onChangeText={setConfirmText}
            />
          )}
          <Pressable
            style={[s.smallBtn, { backgroundColor: '#D32F2F', alignSelf: 'flex-start', marginTop: 8 }, busy && s.disabled]}
            disabled={busy}
            onPress={askDelete}
          >
            <Text style={s.smallBtnText}>{busy ? 'Please wait...' : 'Delete my account'}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
function MemberApp({ gymId, memberId, canSwitch, onSwitch, onSignOut }: { gymId: string; memberId: string; canSwitch: boolean; onSwitch: () => void; onSignOut: () => void }) {
  const [gym, setGym] = useState<Gym | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [me, setMe] = useState<Member | null>(null);
  const [checkins, setCheckins] = useState<CheckIn[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('home');
  const [visitBranch, setVisitBranch] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    const since = addDays(todayISO(), -30);
    const [g, b, p, m, c, po] = await Promise.all([
      supabase.from('gyms').select('*').eq('id', gymId).single(),
      supabase.from('branches').select('*').eq('gym_id', gymId).order('created_at'),
      supabase.from('plans').select('*').eq('gym_id', gymId),
      supabase.from('members').select('*').eq('id', memberId).single(),
      supabase.from('checkins').select('*').eq('member_id', memberId).gte('day', since).order('checked_in_at', { ascending: false }),
      supabase.from('posts').select('*').eq('gym_id', gymId).order('created_at', { ascending: false }),
    ]);
    const failed = [g, b, p, m, c, po].find((r) => r.error);
    if (failed && failed.error) {
      Alert.alert('Could not load data', failed.error.message);
    } else {
      setGym(g.data as Gym);
      setBranches((b.data ?? []) as Branch[]);
      setPlans((p.data ?? []) as Plan[]);
      const mem = m.data as Member;
      setMe(mem);
      setVisitBranch((cur) => cur ?? mem.home_branch_id ?? ((b.data ?? [])[0] as Branch | undefined)?.id ?? null);
      setCheckins((c.data ?? []) as CheckIn[]);
      setPosts((po.data ?? []) as Post[]);
    }
    setLoading(false);
    setRefreshing(false);
  }, [gymId, memberId]);

  useEffect(() => {
    load();
  }, [load]);

    const [calMonth, setCalMonth] = useState(() => todayISO().slice(0, 7));
  const [calDays, setCalDays] = useState<string[]>([]);

  const loadCal = useCallback(async () => {
    const [cy, cm] = calMonth.split('-').map(Number);
    const first = `${calMonth}-01`;
    const last = toISO(new Date(cy, cm, 0));
    const { data } = await supabase
      .from('checkins')
      .select('day')
      .eq('member_id', memberId)
      .gte('day', first)
      .lte('day', last);
    setCalDays((data ?? []).map((r: { day: string }) => r.day));
  }, [calMonth, memberId]);

  useEffect(() => {
    loadCal();
  }, [loadCal, checkins.length]);
  if (loading || !me) return <Loading text="Loading your membership..." />;

  const gymName = gym?.name ?? 'Your gym';
  const plan = plans.find((p) => p.id === me.plan_id);
  const branchName = (id: string | null) => (id ? branches.find((b) => b.id === id)?.name ?? 'Branch' : 'All branches');
  const d = daysLeft(me);
  const today = todayISO();
  const myCheck = checkins.find((c) => c.day === today);
  const last30 = checkins.length;
  const reward = Number(gym?.referral_reward ?? 0);
  
  const shiftMonth = (ym: string, delta: number) => {
    const [sy, sm] = ym.split('-').map(Number);
    const sd = new Date(sy, sm - 1 + delta, 1);
    return `${sd.getFullYear()}-${pad(sd.getMonth() + 1)}`;
  };
  const calYear = Number(calMonth.slice(0, 4));
  const calMon = Number(calMonth.slice(5, 7));
  const daysInMonth = new Date(calYear, calMon, 0).getDate();
  const firstWeekday = new Date(calYear, calMon - 1, 1).getDay();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let n = 1; n <= daysInMonth; n++) cells.push(n);
  while (cells.length % 7 !== 0) cells.push(null);
  const dayIso = (n: number) => `${calMonth}-${pad(n)}`;
  const statusFor = (n: number): 'present' | 'absent' | 'none' => {
    const iso = dayIso(n);
    if (calDays.includes(iso)) return 'present';
    if (iso >= me.start_date && iso < today) return 'absent';
    return 'none';
  };
  let presentCount = 0;
  let absentCount = 0;
  for (let n = 1; n <= daysInMonth; n++) {
    const st = statusFor(n);
    if (st === 'present') presentCount++;
    if (st === 'absent') absentCount++;
  }

  const checkIn = async () => {
    setBusy(true);
    const { error } = await supabase.rpc('check_in', { p_member: me.id, p_branch: visitBranch });
    setBusy(false);
    if (error) {
      Alert.alert('Could not check in', error.message);
      return;
    }
    await load();
  };
  const checkInQr = async (text: string) => {
    setScanning(false);
    if (text.trim().startsWith('gk2:')) {
      const sBranch = text.trim().split(':')[1];
      setBusy(true);
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (perm.status !== 'granted') {
          Alert.alert('Location needed', 'Please allow location so we can confirm you are at the gym.');
          setBusy(false);
          return;
        }
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        const { error: sErr } = await supabase.rpc('check_in_static', {
          p_member: me.id,
          p_branch: sBranch,
          p_lat: pos.coords.latitude,
          p_lng: pos.coords.longitude,
        });
        if (sErr) {
          Alert.alert('Could not check in', sErr.message);
          setBusy(false);
          return;
        }
      } catch (e: any) {
        Alert.alert('Could not check in', e?.message ?? 'Could not read your location');
        setBusy(false);
        return;
      }
      setBusy(false);
      await load();
      return;
    }
    const parts = text.trim().split(':');
    if (parts[0] !== 'gk1' || parts.length < 3) {
      Alert.alert('Not a GymKhata QR', 'Please scan the check-in QR shown at your gym.');
      return;
    }
    const qrBranch = parts[1];
    const token = parts.slice(2).join(':');
    setBusy(true);
    const { error } = await supabase.rpc('check_in_qr', {
      p_member: me.id,
      p_branch: qrBranch,
      p_token: token,
    });
    setBusy(false);
    if (error) {
      Alert.alert('Could not check in', error.message);
      return;
    }
    await load();
  };

  if (scanning) return <QrScanner onScanned={checkInQr} onClose={() => setScanning(false)} />;const modes = gym?.checkin_modes ?? ['tap'];

  const nav = (
    <Nav
      tab={tab}
      onChange={setTab}
      items={[
        { key: 'home', label: 'My plan' },
        { key: 'news', label: 'News' },
        { key: 'refer', label: 'Refer & Earn' },
      ]}
    />
  );
  const header = <Header title={gymName} sub={me.name} canSwitch={canSwitch} onSwitch={onSwitch} onSignOut={onSignOut} />;
  const refresh = () => {
    setRefreshing(true);
    load();
  };

  if (tab === 'news') {
    const list = posts.filter((p) => p.branch_id === null || p.branch_id === me.home_branch_id);
    return (
      <SafeAreaView style={s.screen}>
        {header}
        <Page onRefresh={refresh} refreshing={refreshing}>
          <Text style={s.title}>Announcements</Text>
          {list.length === 0 && <Text style={s.empty}>No announcements yet.</Text>}
          {list.map((p) => (
            <View key={p.id} style={s.panel}>
              <Text style={s.cardName}>{p.title}</Text>
              <Text style={s.meta}>{niceDate(p.created_at)}</Text>
              <Text style={s.bio}>{p.body}</Text>
            </View>
          ))}
        </Page>
        {nav}
      </SafeAreaView>
    );
  }

  if (tab === 'refer') {
    return (
      <SafeAreaView style={s.screen}>
        {header}
        <Page onRefresh={refresh} refreshing={refreshing}>
          <Text style={s.title}>Refer & Earn</Text>
          <View style={s.earnCard}>
            <Text style={s.earnLabel}>Your referral code</Text>
            <Text style={s.earnCode}>{me.referral_code}</Text>
            <Text style={s.earnLabel}>Credit balance</Text>
            <Text style={s.earnValue}>{money(me.credit)}</Text>
          </View>
          <Pressable style={[s.primaryBtn, { marginTop: 12 }]} onPress={() => Share.share({ message: `Join ${gymName}! Tell them my referral code ${me.referral_code} when you join.` })}>
            <Text style={s.primaryBtnText}>Share my code</Text>
          </Pressable>
          <Text style={s.bio}>Earn {money(reward)} credit for every friend who joins with your code and pays. Your credit is deducted from your next renewal.</Text>
        </Page>
        {nav}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.screen}>
      {header}
      <Page onRefresh={refresh} refreshing={refreshing}>
        <Text style={s.title}>Hi, {me.name.split(' ')[0]}</Text>
        <View style={s.earnCard}>
          <View style={s.row}>
            <Text style={s.earnLabel}>{plan?.name ?? 'Membership'} plan</Text>
            {statusBadge(me)}
          </View>
          <Text style={s.earnValue}>{d < 0 ? 'Expired' : d === 0 ? 'Last day' : `${d} days left`}</Text>
          <Text style={s.earnLabel}>Valid until {niceDate(me.expiry_date)}</Text>
          <Text style={[s.earnLabel, { marginTop: 4 }]}>Home branch: {branchName(me.home_branch_id)}</Text>
        </View>
        {feeDue(me) && (
          <View style={s.warnBox}>
            <Text style={s.warnText}>{!me.paid && d >= 0 ? 'Your fee is pending. Please pay at the front desk.' : 'Your membership has expired. Please renew at the front desk.'}</Text>
          </View>
        )}
        <Text style={s.section}>Check in</Text>
        {myCheck ? (
          <View style={[s.primaryBtn, { backgroundColor: '#15803D' }]}>
            <Text style={s.primaryBtnText}>Checked in at {timeOf(myCheck.checked_in_at)}, {branchName(myCheck.branch_id)}</Text>
          </View>
        ) : (
          <>
            {branches.length > 1 && (
              <>
                <Text style={s.label}>Which branch are you at?</Text>
                <View style={s.chipRow}>{branches.map((b) => <Chip key={b.id} label={b.name} on={visitBranch === b.id} onPress={() => setVisitBranch(b.id)} />)}</View>
              </>
            )}
            {modes.includes('tap') && (
  <Pressable style={[s.primaryBtn, busy && s.disabled]} disabled={busy} onPress={checkIn}>
    <Text style={s.primaryBtnText}>{busy ? 'Please wait...' : 'Check in now'}</Text>
  </Pressable>
)}
{(modes.includes('live_qr') || modes.includes('static_qr')) && (
  <Pressable style={[s.primaryBtn, { marginTop: 10 }]} onPress={() => setScanning(true)}>
    <Text style={s.primaryBtnText}>Scan QR to check in</Text>
  </Pressable>
)}
          </>
        )}
        <View style={s.statGrid}>
          <Stat label="Visits in last 30 days" value={last30} />
          <Stat label="Referral credit" value={money(me.credit)} />
        </View>
                <Text style={s.section}>Attendance calendar</Text>
        <View style={s.panel}>
          <View style={s.row}>
            <Pressable onPress={() => setCalMonth(shiftMonth(calMonth, -1))}><Text style={s.switchText}>Prev</Text></Pressable>
            <Text style={s.cardName}>{MONTHS[calMon - 1]} {calYear}</Text>
            <Pressable onPress={() => setCalMonth(shiftMonth(calMonth, 1))}><Text style={s.switchText}>Next</Text></Pressable>
          </View>
          <View style={{ flexDirection: 'row', marginTop: 10 }}>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => (
              <Text key={i} style={[s.meta, { width: '14.2857%', textAlign: 'center' }]}>{w}</Text>
            ))}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {cells.map((n, i) => {
              const st = n ? statusFor(n) : 'none';
              return (
                <View key={i} style={{ width: '14.2857%', alignItems: 'center', paddingVertical: 4 }}>
                  {n ? (
                    <View
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 17,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderWidth: dayIso(n) === today ? 2 : 0,
                        borderColor: '#111827',
                        backgroundColor: st === 'present' ? '#16A34A' : st === 'absent' ? '#DC2626' : '#F3F4F6',
                      }}
                    >
                      <Text style={{ fontWeight: '700', color: st === 'none' ? '#6B7280' : '#FFFFFF' }}>{n}</Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
          <Text style={[s.cardName, { marginTop: 10 }]}>Present {presentCount} days | Absent {absentCount} days</Text>
          <Text style={s.meta}>Green: checked in. Red: did not check in. Grey: today, future, or before you joined.</Text>
        </View>
        <Text style={s.section}>Recent visits</Text>
        {checkins.length === 0 && <Text style={s.empty}>No visits yet.</Text>}
        {checkins.slice(0, 5).map((c) => (
          <View key={c.id} style={s.card}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardName}>{niceDate(c.day)}</Text>
              <Text style={s.meta}>{branchName(c.branch_id)}</Text>
            </View>
            <Text style={s.meta}>{timeOf(c.checked_in_at)}</Text>
          </View>
        ))}
                <AccountSection isOwner={false} />
      </Page>
      {nav}
    </SafeAreaView>
  );
}

export default function App() {
  const [blocked, setBlocked] = useState(false);
    const [toWelcome] = useState(() => {
    try {
      const w = globalThis as any;
      if (Platform.OS !== 'web' || !w.location || w.location.hostname !== 'gymkhata.netlify.app') return false;
      const q = w.location.search + w.location.hash;
      if (/[?&]app=1/.test(q)) w.sessionStorage.setItem('gk_app', '1');
      if (w.sessionStorage.getItem('gk_app') === '1') return false;
      if (/[?&#](code|access_token|refresh_token|error|error_description)=/.test(q)) return false;
      for (let i = 0; i < w.localStorage.length; i++) {
        const k = w.localStorage.key(i) || '';
        if (k.startsWith('sb-') && k.endsWith('-auth-token')) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  });
  useEffect(() => {
    if (toWelcome) (globalThis as any).location.replace('/welcome.html');
  }, [toWelcome]);
  useEffect(() => {
    if (Platform.OS !== 'android' || process.env.EXPO_PUBLIC_DISTRIBUTION !== 'web') return;
    supabase.from('app_config').select('value').eq('key', 'block_web_apk').maybeSingle().then(({ data }) => {
      if (data?.value === 'true') setBlocked(true);
    });
  }, []);
    if (toWelcome) return null;
    if (!blocked) return <AppInner />;
  const openPlay = () => {
    Linking.openURL('market://details?id=com.rayyan.gymdesk').catch(() => Linking.openURL('https://play.google.com/store/apps/details?id=com.rayyan.gymdesk'));
  };
  return (
    <SafeAreaView style={s.screen}>
      <View style={{ padding: 20, paddingTop: 60 }}>
        <Text style={s.title}>Update available</Text>
        <Text style={[s.meta, { marginTop: 12 }]}>This version of GymKhata is no longer supported. Please install the new version from Google Play to keep using the app.</Text>
        <Text style={[s.meta, { marginTop: 12 }]}>If Google Play asks you to uninstall this version first, do that, then install and sign in again. Your gym data is safe.</Text>
        <Pressable style={[s.primaryBtn, { marginTop: 24 }]} onPress={openPlay}>
          <Text style={s.primaryBtnText}>Install from Google Play</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

// =====================================================================
//  APP: sign in, find my gyms, open the right view
// =====================================================================
function AppInner() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const uid = session?.user.id ?? null;
  
  useEffect(() => {
    if (!uid) return;
    registerForPush().then((token) => {
            if (token) {
        supabase.rpc('register_push_token', { p_token: token, p_platform: Platform.OS }).then(({ error }) => {
          if (error) Alert.alert('Push setup problem', error.message);
        });
      }
    });
  }, [uid]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setBooting(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const loadProfiles = useCallback(async () => {
    if (!uid) return;
    const [st, mem] = await Promise.all([
      supabase.from('staff').select('*, gyms(name)').eq('user_id', uid).eq('active', true),
      supabase.from('members').select('*, gyms(name)').eq('user_id', uid),
    ]);
    if (st.error || mem.error) {
      Alert.alert('Could not load your gyms', (st.error ?? mem.error)?.message ?? 'Try again.');
    }
    const list: Profile[] = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(st.data ?? []).map((r: any): Profile => ({ key: 'S' + r.id, kind: 'staff', gymId: r.gym_id, gymName: r.gyms?.name ?? 'Gym', staff: r as Staff })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(mem.data ?? []).map((r: any): Profile => ({ key: 'M' + r.id, kind: 'member', gymId: r.gym_id, gymName: r.gyms?.name ?? 'Gym', memberId: r.id as string })),
    ];
    setProfiles(list);
    setChosenKey(list.length === 1 ? list[0].key : null);
  }, [uid]);

  useEffect(() => {
    setProfiles(null);
    setChosenKey(null);
    if (uid) loadProfiles();
  }, [uid, loadProfiles]);

  const signOut = async () => {
    if (currentPushToken) {
      await supabase.rpc('unregister_push_token', { p_token: currentPushToken });
    }
    supabase.auth.signOut();
  };

  if (booting) return <Loading text="Starting..." />;
  if (!session || !uid) return <AuthScreen />;
  if (profiles === null) return <Loading text="Finding your gym..." />;
  if (profiles.length === 0) {
    return (
      <Onboarding onChanged={() => { setProfiles(null); loadProfiles(); }} onSignOut={signOut} />
    );
  }
  const chosen = profiles.find((p) => p.key === chosenKey);
  if (!chosen) return <ProfilePicker profiles={profiles} onPick={setChosenKey} onChanged={() => { setProfiles(null); loadProfiles(); }} onSignOut={signOut} />;
  const canSwitch = true;
  if (chosen.kind === 'staff') {
    return (
      <SubscriptionGate key={chosen.key} gymId={chosen.gymId} gymName={chosen.gymName} isOwner={chosen.staff.role === 'owner'} canSwitch={canSwitch} onSwitch={() => setChosenKey(null)} onSignOut={signOut}>
        <StaffApp key={chosen.key} me={chosen.staff} userId={uid} canSwitch={canSwitch} onSwitch={() => setChosenKey(null)} onSignOut={signOut} />
      </SubscriptionGate>
    );
  }
  return (
    <SubscriptionGate key={chosen.key} gymId={chosen.gymId} gymName={chosen.gymName} isOwner={false} canSwitch={canSwitch} onSwitch={() => setChosenKey(null)} onSignOut={signOut}>
      <MemberApp key={chosen.key} gymId={chosen.gymId} memberId={chosen.memberId} canSwitch={canSwitch} onSwitch={() => setChosenKey(null)} onSignOut={signOut} />
    </SubscriptionGate>
  );
}

const PRIMARY = '#EA580C';
const INK = '#17130F';
const MUTED = '#7A7167';
const LINE = '#ECE6DE';
const SOFT = {
  shadowColor: '#2B1D0E',
  shadowOpacity: 0.06,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 4 },
  elevation: 2,
};

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FAF8F5' },
  pad: { padding: 18, paddingBottom: 48 },
  center: { flex: 1, justifyContent: 'center', padding: 28 },
  logo: { fontSize: 42, fontWeight: '800', color: INK, letterSpacing: -1 },
  tagline: { fontSize: 16, color: MUTED, marginTop: 8, marginBottom: 30, lineHeight: 24 },
  phoneRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  prefix: { fontSize: 18, fontWeight: '700', color: INK },
  otpInput: { fontSize: 28, letterSpacing: 8, textAlign: 'center' },
  disabled: { opacity: 0.5 },
  googleBtn: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: LINE, borderRadius: 16, padding: 16, alignItems: 'center', ...SOFT },
  googleBtnText: { color: INK, fontSize: 17, fontWeight: '700' },
  orText: { color: MUTED, textAlign: 'center', marginVertical: 14 },
  codeInput: { fontSize: 22, letterSpacing: 3, textAlign: 'center' },
  inviteCode: { color: INK, fontSize: 26, fontWeight: '800', letterSpacing: 2, marginVertical: 8 },
  bigBtnAlt: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: INK },
  bigBtn: { backgroundColor: PRIMARY, borderRadius: 20, padding: 20, marginBottom: 12, ...SOFT },
  bigBtnTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '700' },
  bigBtnSub: { color: '#FFE4D6', fontSize: 14, marginTop: 4 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 14, backgroundColor: '#FAF8F5' },
  headerTitle: { fontSize: 20, fontWeight: '800', color: INK, letterSpacing: -0.3 },
  headerSub: { fontSize: 12, color: MUTED, marginTop: 1 },
  switchText: { color: PRIMARY, fontWeight: '700' },
  scopeBar: { paddingHorizontal: 14, paddingTop: 8, backgroundColor: '#FAF8F5', borderBottomWidth: 1, borderBottomColor: LINE },
  title: { fontSize: 28, fontWeight: '800', color: INK, marginBottom: 14, letterSpacing: -0.6 },
  section: { fontSize: 12, fontWeight: '700', color: MUTED, marginTop: 26, marginBottom: 10, letterSpacing: 1.2, textTransform: 'uppercase' },
  input: { backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1, borderColor: LINE, padding: 14, fontSize: 16, marginBottom: 12, color: INK },
  label: { fontSize: 14, color: MUTED, marginBottom: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 },
  chip: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 22, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: LINE, marginRight: 8, marginBottom: 8 },
  chipOn: { backgroundColor: INK, borderColor: INK },
  chipText: { color: INK, fontWeight: '600' },
  chipTextOn: { color: '#FFFFFF' },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 18, borderWidth: 1, borderColor: LINE, padding: 16, marginBottom: 12, gap: 12, ...SOFT },
  panel: { backgroundColor: '#FFFFFF', borderRadius: 18, borderWidth: 1, borderColor: LINE, padding: 16, marginBottom: 12, ...SOFT },
  cardName: { fontSize: 17, fontWeight: '700', color: INK },
  meta: { fontSize: 13, color: MUTED, marginTop: 3 },
  bio: { fontSize: 15, color: '#3F3A34', marginTop: 8, lineHeight: 22 },
  price: { fontSize: 16, fontWeight: '800', color: INK },
  back: { color: PRIMARY, fontWeight: '700', marginBottom: 10 },
  empty: { color: MUTED, fontSize: 15, lineHeight: 22, marginTop: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 },
  rowLabel: { color: MUTED, fontSize: 15 },
  rowValue: { color: INK, fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'right', marginLeft: 12 },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 12, marginTop: 4 },
  stat: { width: '48%', backgroundColor: '#FFFFFF', borderRadius: 18, borderWidth: 1, borderColor: LINE, padding: 16, ...SOFT },
  statNum: { fontSize: 26, fontWeight: '800', color: INK, letterSpacing: -0.5 },
  statLabel: { fontSize: 13, color: MUTED, marginTop: 3 },
  pendingCard: { backgroundColor: INK, borderRadius: 22, padding: 20, ...SOFT },
  pendingLabel: { color: '#CFC7BD', fontSize: 14 },
  pendingValue: { color: '#FDBA74', fontSize: 34, fontWeight: '800', marginTop: 4, letterSpacing: -0.5 },
  primaryBtn: { backgroundColor: INK, borderRadius: 16, padding: 17, alignItems: 'center' },
  primaryBtnText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  secondaryBtn: { backgroundColor: '#EFE9E1', borderRadius: 16, padding: 16, alignItems: 'center', marginTop: 10 },
  secondaryBtnText: { color: INK, fontSize: 16, fontWeight: '700' },
  smallBtn: { backgroundColor: INK, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 },
  halfBtn: { flex: 1, borderRadius: 12, padding: 12, alignItems: 'center' },
  smallBtnText: { color: '#FFFFFF', fontWeight: '700' },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgeGood: { backgroundColor: '#DCFCE7' },
  badgeWarn: { backgroundColor: '#FEF3C7' },
  badgeBad: { backgroundColor: '#FEE2E2' },
  badgeText: { fontSize: 12, fontWeight: '700' },
  textGood: { color: '#15803D' },
  textWarn: { color: '#B45309' },
  textBad: { color: '#B91C1C' },
  warnBox: { backgroundColor: '#FEF3C7', borderRadius: 14, padding: 14, marginTop: 12 },
  warnText: { color: '#92400E', fontSize: 14, lineHeight: 20 },
  nav: { flexDirection: 'row', backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: LINE },
  navItem: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  navText: { color: MUTED, fontWeight: '600', fontSize: 12 },
  navOn: { color: PRIMARY },
  earnCard: { backgroundColor: INK, borderRadius: 22, padding: 20, ...SOFT },
  earnLabel: { color: '#CFC7BD', fontSize: 14 },
  earnCode: { color: '#FFFFFF', fontSize: 30, fontWeight: '800', letterSpacing: 2, marginVertical: 6 },
  earnValue: { color: '#FDBA74', fontSize: 34, fontWeight: '800', marginVertical: 4, letterSpacing: -0.5 },
});

// ---------- live QR: screen shown at the gym ----------
function LiveQrScreen({ gymId, branches, onClose }: { gymId: string; branches: Branch[]; onClose: () => void }) {
  const [branchId, setBranchId] = useState<string>(branches[0]?.id ?? '');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!branchId) return;
    let stop = false;
    const refresh = async () => {
      const { data, error } = await supabase.rpc('get_live_qr', { p_gym: gymId, p_branch: branchId });
      if (stop) return;
      if (error) {
        setErr(error.message);
        return;
      }
      setErr('');
      setCode(String(data));
    };
    setCode('');
    refresh();
    const t = setInterval(refresh, 20000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [gymId, branchId]);

  return (
    <SafeAreaView style={s.screen}>
      <View style={{ padding: 20, alignItems: 'center' }}>
        <Pressable onPress={onClose} style={{ alignSelf: 'flex-start', marginBottom: 12 }}>
          <Text style={s.back}>Close</Text>
        </Pressable>
        <Text style={s.title}>Check-in QR</Text>
        <Text style={[s.meta, { textAlign: 'center', marginBottom: 12 }]}>
          Members scan this with the app. It changes automatically, so a photo of it stops working.
        </Text>
        {branches.length > 1 && (
          <View style={s.chipRow}>
            {branches.map((b) => (
              <Chip key={b.id} label={b.name} on={branchId === b.id} onPress={() => setBranchId(b.id)} />
            ))}
          </View>
        )}
        <View style={{ backgroundColor: '#fff', padding: 16, borderRadius: 16, marginTop: 16 }}>
          {code ? <QRCode value={code} size={260} /> : <Text style={s.meta}>{err || 'Loading...'}</Text>}
        </View>
        {!!err && !!code && <Text style={s.meta}>{err}</Text>}
      </View>
    </SafeAreaView>
  );
}

// ---------- live QR: scanner on the member's phone ----------
function QrScanner({ onScanned, onClose }: { onScanned: (text: string) => void; onClose: () => void }) {
  const [perm, requestPerm] = useCameraPermissions();
  const done = useRef(false);

  if (!perm) return <View />;

  if (!perm.granted) {
    return (
      <SafeAreaView style={s.screen}>
        <View style={{ padding: 20 }}>
          <Text style={s.title}>Camera needed</Text>
          <Text style={s.meta}>Allow the camera to scan the gym's QR code.</Text>
          <Pressable style={[s.primaryBtn, { marginTop: 16 }]} onPress={() => requestPerm()}>
            <Text style={s.primaryBtnText}>Allow camera</Text>
          </Pressable>
          <Pressable onPress={onClose} style={{ marginTop: 16 }}>
            <Text style={s.back}>Cancel</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={(r) => {
          if (done.current) return;
          done.current = true;
          onScanned(r.data);
        }}
      />
      <Pressable onPress={onClose} style={{ position: 'absolute', bottom: 40, alignSelf: 'center', backgroundColor: '#fff', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24 }}>
        <Text style={s.back}>Cancel</Text>
      </Pressable>
    </View>
  );
}

// ---------- printed QR: fixed QR for the wall + set branch location ----------
function StaticQrScreen({ gymId, branches, onClose }: { gymId: string; branches: Branch[]; onClose: () => void }) {
  const [branchId, setBranchId] = useState<string>(branches[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const branch = branches.find((b) => b.id === branchId);

  const saveLocation = async () => {
    if (!branchId) return;
    setBusy(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert('Location needed', 'Please allow location so we can save where your gym is.');
        setBusy(false);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const { error } = await supabase.rpc('set_branch_location', {
        p_gym: gymId,
        p_branch: branchId,
        p_lat: pos.coords.latitude,
        p_lng: pos.coords.longitude,
        p_radius: 150,
      });
      if (error) Alert.alert('Could not save', error.message);
      else Alert.alert('Saved', 'Location saved for ' + (branch?.name ?? 'this branch') + '.');
    } catch (e: any) {
      Alert.alert('Could not read location', e?.message ?? 'Please try again');
    }
    setBusy(false);
  };

  return (
    <SafeAreaView style={s.screen}>
      <View style={{ padding: 20 }}>
        <Pressable onPress={onClose}>
          <Text style={s.back}>Back</Text>
        </Pressable>
        <Text style={s.title}>Printed check-in QR</Text>
        <Text style={s.meta}>Print this QR and stick it at the gym. Members must be within 150 m of the saved location to check in.</Text>
        {branches.length > 1 && (
          <View style={s.chipRow}>
            {branches.map((b) => (
              <Chip key={b.id} label={b.name} on={branchId === b.id} onPress={() => setBranchId(b.id)} />
            ))}
          </View>
        )}
        {branchId ? (
          <View style={{ alignSelf: 'center', backgroundColor: '#fff', padding: 16, borderRadius: 16, marginTop: 16 }}>
            <QRCode value={'gk2:' + branchId} size={240} />
          </View>
        ) : null}
        <Pressable style={[s.primaryBtn, busy && s.disabled, { marginTop: 20 }]} disabled={busy} onPress={saveLocation}>
          <Text style={s.primaryBtnText}>{busy ? 'Please wait...' : 'Set branch location (stand at the gym)'}</Text>
        </Pressable>
        <Text style={[s.meta, { marginTop: 8 }]}>Press this button on your phone while you are standing inside the gym.</Text>
      </View>
    </SafeAreaView>
  );
}

// ---------- subscription gate: blocks the app when the gym's subscription has ended ----------
function SubscriptionGate({
  gymId,
  gymName,
  isOwner,
  canSwitch,
  onSwitch,
  onSignOut,
  children,
}: {
  gymId: string;
  gymName: string;
  isOwner: boolean;
  canSwitch: boolean;
  onSwitch: () => void;
  onSignOut: () => void;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<'loading' | 'active' | 'ended'>('loading');
  const [until, setUntil] = useState('');

  const check = useCallback(async () => {
    setState('loading');
    const { data, error } = await supabase.rpc('subscription_status', { p_gym: gymId });
    if (error) {
      setState('active');
      return;
    }
    const row: any = Array.isArray(data) ? data[0] : data;
    if (!row) {
      setUntil('');
      setState('ended');
      return;
    }
    setUntil(String(row.paid_until ?? '').slice(0, 10));
    setState(row.is_active ? 'active' : 'ended');
  }, [gymId]);

  useEffect(() => {
    check();
  }, [check]);

  if (state === 'loading') return <Loading text="Checking subscription..." />;
  if (state === 'active') return <>{children}</>;

  return (
    <SafeAreaView style={s.screen}>
      <View style={{ padding: 20, paddingTop: 60 }}>
        <Text style={s.title}>Subscription ended</Text>
        <Text style={s.meta}>{gymName}</Text>
        {until ? <Text style={[s.meta, { marginTop: 6 }]}>Paid until {until}</Text> : null}
        <Text style={[s.meta, { marginTop: 16 }]}>
          {isOwner
            ? 'This gym\u2019s subscription has ended, so the app is paused for everyone. Renew the subscription to continue.'
            : 'This gym\u2019s subscription has ended, so the app is paused. Please ask your gym owner to renew it.'}
        </Text>
        {isOwner && IS_WEB ? <PayPanel gymId={gymId} onPaid={check} /> : null}
                {IS_WEB ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 16 }}>
            {[['Terms', 'terms'], ['Privacy', 'privacy'], ['Refunds', 'refund'], ['Pricing', 'pricing'], ['About', 'about'], ['Contact', 'contact']].filter(([, p]) => IS_WEB || (p !== 'pricing' && p !== 'refund')).map(([label, page]) => (
              <Pressable key={page} onPress={() => Linking.openURL('https://gymkhata.netlify.app/' + page + '.html')}>
                <Text style={[s.meta, { textDecorationLine: 'underline', marginHorizontal: 8, paddingVertical: 4 }]}>{label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Pressable style={[s.primaryBtn, { marginTop: 20 }]} onPress={check}>
          <Text style={s.primaryBtnText}>Check again</Text>
        </Pressable>
                <Pressable onPress={() => openWhatsAppChat(SUPPORT_WHATSAPP, 'Hi, I need help with my GymKhata subscription for ' + gymName)} style={{ marginTop: 16 }}>
          <Text style={[s.switchText, { textAlign: 'center' }]}>Contact support on WhatsApp</Text>
        </Pressable>
        {canSwitch && (
          <Pressable onPress={onSwitch} style={{ marginTop: 16 }}>
            <Text style={[s.switchText, { textAlign: 'center' }]}>Switch gym</Text>
          </Pressable>
        )}
        <Pressable onPress={onSignOut} style={{ marginTop: 16 }}>
          <Text style={[s.switchText, { textAlign: 'center' }]}>Sign out</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

// ---------- web payment panel (Razorpay) ----------
const IS_WEB = typeof (globalThis as any).document !== 'undefined';

function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    const w: any = globalThis;
    if (w.Razorpay) return resolve(true);
    const el = w.document.createElement('script');
    el.src = 'https://checkout.razorpay.com/v1/checkout.js';
    el.onload = () => resolve(true);
    el.onerror = () => resolve(false);
    w.document.body.appendChild(el);
  });
}

async function fnError(error: any): Promise<string> {
  try {
    const j = await error.context.json();
    return j?.error ?? error.message;
  } catch {
    return error?.message ?? 'Something went wrong';
  }
}

function PayPanel({ gymId, onPaid }: { gymId: string; onPaid: () => void }) {
  const [months, setMonths] = useState(1);
  const [code, setCode] = useState('');
  const [appliedCode, setAppliedCode] = useState('');
  const [quote, setQuote] = useState<any>(null);
  const [codeMsg, setCodeMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const getQuote = useCallback(async () => {
    setMsg('');
    const { data, error } = await supabase.rpc('quote_subscription', {
      p_gym: gymId,
      p_months: months,
      p_code: appliedCode || null,
    });
    if (error) {
            if (appliedCode) {
        setCodeMsg(error.message);
        setAppliedCode('');
        return;
      }
      setQuote(null);
      setMsg(error.message);
      return;
    }
    setQuote(Array.isArray(data) ? data[0] : data);
  }, [gymId, months, appliedCode]);

  useEffect(() => {
    getQuote();
  }, [getQuote]);

  const pay = async () => {
    setBusy(true);
    setMsg('');
    const { data, error } = await supabase.functions.invoke('create-order', {
      body: { gym_id: gymId, months, code: appliedCode || null },
    });
    if (error) {
      setBusy(false);
      setMsg(await fnError(error));
      return;
    }
    if (data?.free) {
      setBusy(false);
      setMsg('Subscription renewed.');
      onPaid();
      return;
    }
    const ok = await loadRazorpayScript();
    if (!ok) {
      setBusy(false);
      setMsg('Could not load the payment window. Check your internet and try again.');
      return;
    }
    const Rz = (globalThis as any).Razorpay;
    const rz = new Rz({
      key: data.key_id,
      amount: data.amount,
      currency: data.currency,
      order_id: data.razorpay_order_id,
      name: 'GymKhata',
      description: 'Gym subscription, ' + months + (months === 1 ? ' month' : ' months'),
      theme: { color: '#EA580C' },
      modal: { ondismiss: () => setBusy(false) },
      handler: async (resp: any) => {
        const { error: vErr } = await supabase.functions.invoke('verify-payment', {
          body: {
            order_uuid: data.order_uuid,
            razorpay_order_id: resp.razorpay_order_id,
            razorpay_payment_id: resp.razorpay_payment_id,
            razorpay_signature: resp.razorpay_signature,
          },
        });
        setBusy(false);
        if (vErr) {
          setMsg(await fnError(vErr));
          return;
        }
        setMsg('Payment received. Subscription renewed.');
        onPaid();
      },
    });
    rz.on('payment.failed', (r: any) => {
      setBusy(false);
      setMsg(r?.error?.description ?? 'Payment failed. Please try again.');
    });
    rz.open();
  };

  return (
    <View style={{ marginTop: 20 }}>
      <Text style={s.section}>Renew subscription</Text>
      <Text style={s.meta}>Rs 299 per month for each branch.</Text>
      <View style={s.chipRow}>
        {[1, 3, 12].map((m) => (
          <Chip key={m} label={m + (m === 1 ? ' month' : ' months')} on={months === m} onPress={() => setMonths(m)} />
        ))}
      </View>
      <TextInput style={s.input} value={code} onChangeText={setCode} placeholder="Promo code (optional)" autoCapitalize="characters" />
      <Pressable style={[s.smallBtn, { alignSelf: 'flex-start', marginTop: 8 }]} onPress={() => { setCodeMsg(''); setAppliedCode(code.trim()); }}>
        <Text style={s.smallBtnText}>Apply code</Text>
      </Pressable>
      {quote ? (
        <View style={{ marginTop: 12 }}>
          <Text style={s.meta}>
            {quote.branch_count} {quote.branch_count === 1 ? 'branch' : 'branches'} x {months} {months === 1 ? 'month' : 'months'} = {money(Number(quote.base_amount))}
          </Text>
          {Number(quote.discount_amount) > 0 ? <Text style={s.meta}>Promo discount: -{money(Number(quote.discount_amount))}</Text> : null}
          <Text style={s.cardName}>Total {money(Number(quote.total_amount))}</Text>
        </View>
      ) : null}
      {codeMsg ? <Text style={[s.meta, { marginTop: 8 }]}>{codeMsg}</Text> : null}
        {msg ? <Text style={[s.meta, { marginTop: 8 }]}>{msg}</Text> : null}
      <Pressable style={[s.primaryBtn, (busy || !quote) && s.disabled, { marginTop: 16 }]} disabled={busy || !quote} onPress={pay}>
        <Text style={s.primaryBtnText}>{busy ? 'Please wait...' : 'Pay ' + money(Number(quote?.total_amount ?? 0))}</Text>
      </Pressable>
    </View>
  );
}

// ---------- "subscription ending soon" notice for owners ----------
const RENEWAL_WARN_DAYS = 7;

function RenewalBanner({ gymId }: { gymId: string }) {
  const [until, setUntil] = useState('');
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('subscription_status', { p_gym: gymId });
    if (error) return;
    const row: any = Array.isArray(data) ? data[0] : data;
    setUntil(row?.paid_until ? String(row.paid_until).slice(0, 10) : '');
  }, [gymId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!until) return null;
  const days = Math.round((Date.parse(until + 'T00:00:00Z') - Date.parse(todayISO() + 'T00:00:00Z')) / 86400000);
  if (days < 0 || days > RENEWAL_WARN_DAYS) return null;

  const text =
    days === 0
      ? 'Your gym subscription ends today.'
      : days === 1
        ? 'Your gym subscription ends tomorrow.'
        : 'Your gym subscription ends in ' + days + ' days.';

  return (
    <View style={{ backgroundColor: '#FFF4E8', borderColor: PRIMARY, borderWidth: 1, borderRadius: 16, padding: 14, marginBottom: 12 }}>
      <Text style={s.cardName}>{text}</Text>
      <Text style={[s.meta, { marginTop: 4 }]}>
        Paid until {until}. When it ends, the app is paused for you, your staff and your members.
      </Text>
      {IS_WEB ? (
        <>
          <Pressable style={[s.smallBtn, { alignSelf: 'flex-start', marginTop: 10 }]} onPress={() => setOpen(!open)}>
            <Text style={s.smallBtnText}>{open ? 'Hide' : 'Renew now'}</Text>
          </Pressable>
          {open ? (
            <PayPanel
              gymId={gymId}
              onPaid={() => {
                setOpen(false);
                load();
              }}
            />
          ) : null}
        </>
      ) : (
        <Text style={[s.meta, { marginTop: 8 }]}>Please renew your subscription before it ends.</Text>
      )}
              <Pressable onPress={() => openWhatsAppChat(SUPPORT_WHATSAPP, 'Hi, I need help with my GymKhata subscription')} style={{ alignSelf: 'flex-start', marginTop: 10 }}>
          <Text style={[s.meta, { textDecorationLine: 'underline' }]}>Contact support on WhatsApp</Text>
        </Pressable>
    </View>
  );
}