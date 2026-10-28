import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import {
  LEAD_STATUSES,
  dialLead,
  fetchLeads,
  formatPhoneForDisplay,
  leadStatusMeta,
  type Lead,
} from '../services/crm';
import { addLeadsToIndex, refreshLeadPhoneIndex } from '../services/leadIndex';
import { theme } from '../theme';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 400;
/** Near-real-time: re-fetch the first page while the tab is open. */
const POLL_INTERVAL_MS = 60 * 1000;

interface StatusFilter {
  key: string;
  label: string;
  status: string[];
  /** Chip dot colour; undefined for "All" */
  color?: string;
}

/** "All" first (every lead the CRM lists), then one chip per CRM status. */
const STATUS_FILTERS: StatusFilter[] = [
  { key: 'all', label: 'All', status: [] },
  ...LEAD_STATUSES.map((s) => ({ key: s.slug, label: s.short, status: [s.slug], color: s.fg })),
];

function formatFollowUp(value?: string | null): string {
  if (!value) return '';
  const t = Date.parse(value.replace(' ', 'T'));
  if (!Number.isFinite(t)) return value;
  return new Date(t).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

function LeadRow({ lead, onCall }: { lead: Lead; onCall: (lead: Lead) => void }) {
  const phone = formatPhoneForDisplay(lead.phone) || formatPhoneForDisplay(lead.alternate_phone);
  const title = (lead.name || '').trim() || phone || 'Unnamed lead';
  const followUp = formatFollowUp(lead.follow_up_date);
  const secondary = [lead.treatment, lead.lead_source].filter(Boolean).join(' · ');
  const status = leadStatusMeta(lead.status);
  return (
    <TouchableOpacity
      style={[styles.row, { borderLeftColor: status.fg }]}
      onPress={() => onCall(lead)}
      activeOpacity={0.8}
    >
      <View style={styles.rowMain}>
        <View style={styles.rowTop}>
          <Text style={styles.name} numberOfLines={1}>{title}</Text>
          <View style={[styles.badge, { backgroundColor: status.bg }]}>
            <Text style={[styles.badgeText, { color: status.fg }]} numberOfLines={1}>
              {status.short}
            </Text>
          </View>
        </View>
        {phone && title !== phone ? (
          <Text style={styles.phone}>{phone}</Text>
        ) : null}
        {secondary ? (
          <Text style={styles.meta} numberOfLines={1}>{secondary}</Text>
        ) : null}
        {followUp ? (
          <View style={styles.followUpRow}>
            <Icon name="calendar-clock" size={14} color={theme.colors.textSecondary} />
            <Text style={styles.meta}>Follow up {followUp}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.callBtn}>
        <Icon name="phone" size={22} color={theme.colors.textOnPrimary} />
      </View>
    </TouchableOpacity>
  );
}

export function LeadsScreen() {
  const insets = useSafeAreaInsets();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [page, setPage] = useState(1);
  const [lastPage, setLastPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filterKey, setFilterKey] = useState<string>('all');
  const requestIdRef = useRef(0);
  const loadedOnceRef = useRef(false);
  const loadRef = useRef<(mode: 'initial' | 'refresh' | 'more' | 'poll') => Promise<void>>(async () => undefined);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const activeFilter = STATUS_FILTERS.find((f) => f.key === filterKey) ?? STATUS_FILTERS[0];

  const load = useCallback(
    async (mode: 'initial' | 'refresh' | 'more' | 'poll') => {
      // Silent background poll: only while the list shows its first page.
      if (mode === 'poll' && page > 1) return;
      const requestId = ++requestIdRef.current;
      const nextPage = mode === 'more' ? page + 1 : 1;
      if (mode === 'initial') setLoading(true);
      if (mode === 'refresh') setRefreshing(true);
      if (mode === 'more') setLoadingMore(true);
      if (mode === 'initial' || mode === 'refresh') setError(null);
      try {
        const result = await fetchLeads({
          page: nextPage,
          perPage: PAGE_SIZE,
          status: activeFilter.status,
          search: debouncedSearch,
        });
        if (requestId !== requestIdRef.current) return;
        // Keep the local lead-number index current so Call logs can filter immediately.
        addLeadsToIndex(result.items);
        setLeads((prev) => (mode === 'more' ? [...prev, ...result.items] : result.items));
        setPage(result.page);
        setLastPage(result.lastPage);
        setTotal(result.total);
        loadedOnceRef.current = true;
      } catch (e) {
        if (requestId !== requestIdRef.current) return;
        // A failed background poll keeps the current list without an error box.
        if (mode !== 'poll') setError(e instanceof Error ? e.message : 'Failed to load leads.');
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [page, activeFilter, debouncedSearch]
  );

  // Keep a stable reference to the latest loader for the focus/poll effect.
  loadRef.current = load;

  // Full refresh of the lead-number index once per screen mount (all statuses).
  useEffect(() => {
    refreshLeadPhoneIndex();
  }, []);

  // Reload whenever the filter or search changes.
  useEffect(() => {
    load('initial');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, debouncedSearch]);

  // Refresh when the tab regains focus (after a call, for instance) and poll
  // every minute while it stays open, so new leads show up without a restart.
  // Filter/search changes are handled by the effect above, not here.
  useFocusEffect(
    useCallback(() => {
      if (loadedOnceRef.current) loadRef.current('refresh');
      const id = setInterval(() => loadRef.current('poll'), POLL_INTERVAL_MS);
      return () => clearInterval(id);
    }, [])
  );

  const handleCall = useCallback(async (lead: Lead) => {
    try {
      const ok = await dialLead(lead);
      if (!ok) Alert.alert('No number', 'This lead has no phone number.');
    } catch (e) {
      Alert.alert('Could not open dialer', e instanceof Error ? e.message : 'Unknown error');
    }
  }, []);

  const handleEndReached = useCallback(() => {
    if (loading || loadingMore || refreshing) return;
    if (page >= lastPage) return;
    load('more');
  }, [loading, loadingMore, refreshing, page, lastPage, load]);

  return (
    <View style={[styles.container, { paddingTop: insets.top + theme.spacing.md }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Leads</Text>
        <Text style={styles.subtitle}>
          {total > 0
            ? `${total} ${activeFilter.key === 'all' ? 'lead' : activeFilter.label.toLowerCase() + ' lead'}${total === 1 ? '' : 's'} · tap to call`
            : 'Tap a lead to call'}
        </Text>
      </View>

      <View style={styles.searchBox}>
        <Icon name="magnify" size={20} color={theme.colors.tabInactive} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search name or phone"
          placeholderTextColor={theme.colors.tabInactive}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')} accessibilityLabel="Clear search">
            <Icon name="close-circle" size={18} color={theme.colors.tabInactive} />
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipsScroll}
        contentContainerStyle={styles.chips}
      >
        {STATUS_FILTERS.map((f) => {
          const active = f.key === filterKey;
          return (
            <TouchableOpacity
              key={f.key}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => setFilterKey(f.key)}
            >
              {f.color ? (
                <View
                  style={[
                    styles.chipDot,
                    { backgroundColor: active ? theme.colors.textOnPrimary : f.color },
                  ]}
                />
              ) : (
                <Icon
                  name="view-list-outline"
                  size={14}
                  color={active ? theme.colors.textOnPrimary : theme.colors.textSecondary}
                />
              )}
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => load('initial')}>
            <Text style={styles.link}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {loading && leads.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : (
        <FlatList
          data={leads}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => <LeadRow lead={item} onCall={handleCall} />}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load('refresh')}
              colors={[theme.colors.primary]}
              tintColor={theme.colors.primary}
            />
          }
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator style={styles.footerLoader} color={theme.colors.primary} />
            ) : null
          }
          ListEmptyComponent={
            !loading && !refreshing && !error ? (
              <View style={styles.emptyBox}>
                <Icon name="account-search-outline" size={40} color={theme.colors.tabInactive} />
                <Text style={styles.empty}>
                  {debouncedSearch ? 'No leads match your search.' : 'No leads in this list.'}
                </Text>
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.backgroundSecondary,
    paddingHorizontal: theme.spacing.lg,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    marginBottom: theme.spacing.md,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: theme.colors.text,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    marginTop: theme.spacing.xs,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    backgroundColor: theme.colors.white,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
  },
  searchInput: {
    flex: 1,
    paddingVertical: theme.spacing.sm + 2,
    fontSize: 15,
    color: theme.colors.text,
  },
  chipsScroll: {
    flexGrow: 0,
    marginBottom: theme.spacing.sm,
  },
  chips: {
    gap: theme.spacing.sm,
    paddingVertical: 2,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 7,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.white,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
  },
  chipDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  chipActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.textSecondary,
  },
  chipTextActive: {
    color: theme.colors.textOnPrimary,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: theme.spacing.xl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    borderLeftWidth: 4,
    borderLeftColor: theme.colors.primary,
    ...theme.shadows.sm,
  },
  rowMain: {
    flex: 1,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  name: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.text,
  },
  badge: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    borderRadius: theme.radius.full,
    maxWidth: 150,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  phone: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  meta: {
    fontSize: 13,
    color: theme.colors.tabInactive,
    marginTop: 2,
  },
  followUpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  callBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: theme.spacing.sm,
  },
  footerLoader: {
    marginVertical: theme.spacing.md,
  },
  errorBox: {
    backgroundColor: theme.colors.white,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.error,
    marginBottom: theme.spacing.sm,
  },
  errorText: {
    color: theme.colors.error,
    fontSize: 14,
    marginBottom: theme.spacing.xs,
  },
  link: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  emptyBox: {
    alignItems: 'center',
    marginTop: theme.spacing.xl,
    gap: theme.spacing.sm,
  },
  empty: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
  },
});
