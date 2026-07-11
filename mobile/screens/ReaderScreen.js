import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, SafeAreaView, ActivityIndicator, Alert,
} from 'react-native';
import { Reader, useReader } from '@epubjs-react-native/core';
import { useFileSystem } from '@epubjs-react-native/expo-file-system';
import {
  getBookContext, getBookFileUrl, getHighlights, saveHighlight, updateProgress,
} from '../lib/api';

const BLUE = '#4f8ef7';

// 三套主题：亮色 / 暖纸色（护眼） / 深色，对应范围声明里确认的阅读体验要求
const THEMES = {
  light: { body: { background: '#ffffff', color: '#1a1a2e' } },
  paper: { body: { background: '#f4ecd8', color: '#5b4636' } },
  dark:  { body: { background: '#1a1a2e', color: '#dcdce6' } },
};
const THEME_ORDER = ['light', 'paper', 'dark'];
const THEME_LABEL = { light: '☀️', paper: '📜', dark: '🌙' };

// 进度上报节流：翻页很频繁，没必要每次都请求后端
const PROGRESS_DEBOUNCE_MS = 2000;

function ReaderInner({ bookId, bookTitle, initialLocation, initialAnnotations, navigation }) {
  const { addAnnotation, changeTheme } = useReader();
  const [themeName, setThemeName] = useState('light');
  const progressTimer = useRef(null);
  const annotationsRestored = useRef(false);

  // initialAnnotations 要等 Reader 的 onReady 触发（book 真正渲染完成）才能加，
  // 提前调用 addAnnotation 会静默失效，所以不能放进 mount 时的 effect 里。
  function handleReady() {
    if (annotationsRestored.current) return;
    annotationsRestored.current = true;
    for (const h of initialAnnotations) {
      addAnnotation('highlight', h.cfi_location, { id: h.id }, { color: '#ffd54f' });
    }
  }

  function handleLocationChange(_total, currentLocation) {
    const cfi = currentLocation?.start?.cfi;
    if (!cfi) return;
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = setTimeout(() => {
      updateProgress(bookId, cfi).catch((e) => console.warn('[进度上报失败]', e.message));
    }, PROGRESS_DEBOUNCE_MS);
  }

  async function handleHighlight(cfiRange, text) {
    try {
      const saved = await saveHighlight(bookId, { cfiLocation: cfiRange, highlightedText: text });
      addAnnotation('highlight', cfiRange, { id: saved.id }, { color: '#ffd54f' });
    } catch (e) {
      Alert.alert('划线保存失败', e.message || '请稍后重试');
    }
    return false; // 保留选区高亮，不清除
  }

  function cycleTheme() {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(themeName) + 1) % THEME_ORDER.length];
    setThemeName(next);
    changeTheme(THEMES[next]);
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: THEMES[themeName].body.background }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>‹ 书架</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{bookTitle}</Text>
        <TouchableOpacity onPress={cycleTheme} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>{THEME_LABEL[themeName]}</Text>
        </TouchableOpacity>
      </View>

      <Reader
        src={getBookFileUrl(bookId)}
        fileSystem={useFileSystem}
        width="100%"
        height="100%"
        defaultTheme={THEMES.light}
        initialLocation={initialLocation || undefined}
        onReady={handleReady}
        onLocationChange={handleLocationChange}
        menuItems={[
          {
            label: '划线',
            action: (cfiRange, text) => {
              handleHighlight(cfiRange, text);
              return false;
            },
          },
        ]}
        renderLoadingFileComponent={() => (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color={BLUE} />
            <Text style={styles.loadingText}>正在下载书本…</Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

export default function ReaderScreen({ route, navigation }) {
  const { bookId } = route.params;
  const [ctx, setCtx] = useState(null);
  const [highlights, setHighlights] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [c, h] = await Promise.all([getBookContext(bookId), getHighlights(bookId)]);
      setCtx(c);
      setHighlights(h);
    } catch (e) {
      setError(e.message || '加载失败');
    }
  }, [bookId]);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centerBox}>
          <Text style={styles.errorText}>打开失败：{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.retryText}>返回书架</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (!ctx || !highlights) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={BLUE} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <ReaderInner
      bookId={bookId}
      bookTitle={ctx.title}
      initialLocation={ctx.current_cfi_location}
      initialAnnotations={highlights}
      navigation={navigation}
    />
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: BLUE,
  },
  headerBtn: { padding: 6, minWidth: 44 },
  headerBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  headerTitle: { flex: 1, textAlign: 'center', color: '#fff', fontSize: 16, fontWeight: '700' },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: '#8a95b0', fontSize: 13 },
  errorText: { color: '#f7564f', fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  retryBtn: {
    marginTop: 16, paddingHorizontal: 20, paddingVertical: 10,
    backgroundColor: BLUE, borderRadius: 10,
  },
  retryText: { color: '#fff', fontWeight: '600' },
});
