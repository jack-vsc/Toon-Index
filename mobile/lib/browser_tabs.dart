import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'theme.dart';

/// A tab of the app's browser. Without [url] it shows the start page.
class BrowserTab {
  BrowserTab({required this.id, this.url, this.title = '', this.group, int? usedAt}) : usedAt = usedAt ?? DateTime.now().millisecondsSinceEpoch;

  final String id;
  String? url;
  String title;
  String? group;

  /// When it was last shown: the ones not shown for longest are let go of first (only their address stays).
  int usedAt;

  String get label => title.isNotEmpty ? title : (url != null ? hostOf(url!) : 'Nova aba');

  Map<String, dynamic> toJson() => {'id': id, 'url': url, 'title': title, 'group': group, 'usedAt': usedAt};

  factory BrowserTab.fromJson(Map<String, dynamic> j) =>
      BrowserTab(id: j['id'] as String, url: j['url'] as String?, title: j['title'] as String? ?? '', group: j['group'] as String?, usedAt: (j['usedAt'] as num?)?.toInt());
}

/// Tabs kept together under a name and a color, as in Chrome.
class TabGroup {
  TabGroup({required this.id, required this.name, required this.color});

  final String id;
  String name;
  int color;

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'color': color};

  factory TabGroup.fromJson(Map<String, dynamic> j) => TabGroup(id: j['id'] as String, name: j['name'] as String? ?? '', color: (j['color'] as num).toInt());
}

/// A page saved as a favorite or visited (history).
class SavedPage {
  SavedPage({required this.url, required this.title, required this.at});

  final String url;
  final String title;
  final int at;

  String get label => title.isNotEmpty ? title : hostOf(url);

  Map<String, dynamic> toJson() => {'url': url, 'title': title, 'at': at};

  factory SavedPage.fromJson(Map<String, dynamic> j) => SavedPage(url: j['url'] as String, title: j['title'] as String? ?? '', at: (j['at'] as num).toInt());
}

String hostOf(String url) => Uri.tryParse(url)?.host.replaceFirst(RegExp(r'^www\.'), '') ?? url;

const groupColors = [0xFF5B8DEF, 0xFFE5484D, 0xFFF5A524, 0xFF4CCF8A, 0xFFB56CF0, 0xFF3DC7C7, 0xFFFF8A5C, 0xFF9E9EA8];

/// The browser's tabs, groups, favorites and history, kept on the phone between uses.
class BrowserData extends ChangeNotifier {
  BrowserData._();

  static final instance = BrowserData._();
  static const _key = 'browser.data';
  static const _maxHistory = 1000;

  final List<BrowserTab> tabs = [];
  final List<TabGroup> groups = [];
  final List<SavedPage> favorites = [];
  final List<SavedPage> history = [];
  String? activeId;
  bool _loaded = false;
  Timer? _saving;

  BrowserTab? get active => tabs.where((t) => t.id == activeId).firstOrNull ?? tabs.lastOrNull;

  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    final text = (await SharedPreferences.getInstance()).getString(_key);
    if (text != null) {
      try {
        final j = jsonDecode(text) as Map<String, dynamic>;
        List<T> list<T>(String key, T Function(Map<String, dynamic>) make) => [for (final e in (j[key] as List? ?? [])) make(e as Map<String, dynamic>)];
        tabs.addAll(list('tabs', BrowserTab.fromJson));
        groups.addAll(list('groups', TabGroup.fromJson));
        favorites.addAll(list('favorites', SavedPage.fromJson));
        history.addAll(list('history', SavedPage.fromJson));
        activeId = j['active'] as String?;
      } catch (_) {
        // Saved by an older version in another shape: start clean.
      }
    }
    if (tabs.isEmpty) newTab();
  }

  /// Saved a moment after the last change: a page loading changes its tab several times.
  void changed() {
    notifyListeners();
    _saving?.cancel();
    _saving = Timer(const Duration(milliseconds: 600), _save);
  }

  Future<void> _save() async {
    final json = jsonEncode({
      'tabs': tabs,
      'groups': groups,
      'favorites': favorites,
      'history': history,
      'active': activeId,
    });
    await (await SharedPreferences.getInstance()).setString(_key, json);
  }

  String _id() => '${DateTime.now().microsecondsSinceEpoch}${tabs.length}';

  BrowserTab newTab({String? url, String? group}) {
    final tab = BrowserTab(id: _id(), url: url, group: group);
    tabs.add(tab);
    activeId = tab.id;
    changed();
    return tab;
  }

  void select(String id) {
    activeId = id;
    tabs.where((t) => t.id == id).firstOrNull?.usedAt = DateTime.now().millisecondsSinceEpoch;
    changed();
  }

  /// Closes the tab; the last one closed leaves a new, empty one.
  void close(String id) {
    final i = tabs.indexWhere((t) => t.id == id);
    if (i < 0) return;
    tabs.removeAt(i);
    _dropEmptyGroups();
    if (tabs.isEmpty) {
      newTab();
      return;
    }
    if (activeId == id) activeId = tabs[i.clamp(0, tabs.length - 1)].id;
    changed();
  }

  void closeGroup(String groupId) {
    for (final t in tabs.where((t) => t.group == groupId).toList()) {
      close(t.id);
    }
  }

  TabGroup addGroup(String name) {
    final group = TabGroup(id: 'g${_id()}', name: name, color: groupColors[groups.length % groupColors.length]);
    groups.add(group);
    changed();
    return group;
  }

  void moveToGroup(String tabId, String? groupId) {
    tabs.where((t) => t.id == tabId).firstOrNull?.group = groupId;
    _dropEmptyGroups();
    changed();
  }

  /// The group's tabs back out on their own, the group gone.
  void ungroup(String groupId) {
    for (final t in tabs.where((t) => t.group == groupId)) {
      t.group = null;
    }
    _dropEmptyGroups();
    changed();
  }

  void _dropEmptyGroups() => groups.removeWhere((g) => !tabs.any((t) => t.group == g.id));

  /// The tab went to [url] (titled [title] once the page says).
  void visited(BrowserTab tab, String url, String title) {
    tab.url = url;
    if (title.isNotEmpty) tab.title = title;
    if (url.startsWith('http')) {
      // A page reloaded or retitled is still one visit.
      if (history.isNotEmpty && history.first.url == url) history.removeAt(0);
      history.insert(0, SavedPage(url: url, title: title, at: DateTime.now().millisecondsSinceEpoch));
      if (history.length > _maxHistory) history.removeRange(_maxHistory, history.length);
    }
    changed();
  }

  bool isFavorite(String? url) => url != null && favorites.any((f) => f.url == url);

  void toggleFavorite(String url, String title) {
    if (isFavorite(url)) {
      favorites.removeWhere((f) => f.url == url);
    } else {
      favorites.insert(0, SavedPage(url: url, title: title, at: DateTime.now().millisecondsSinceEpoch));
    }
    changed();
  }

  void removeFavorite(SavedPage page) {
    favorites.remove(page);
    changed();
  }

  void removeVisit(SavedPage page) {
    history.remove(page);
    changed();
  }

  void clearHistory() {
    history.clear();
    changed();
  }
}

/// Every tab, alone or in its group, to switch to, close, group or open a new one. Pops with the id of
/// the tab to show.
class TabsScreen extends StatelessWidget {
  const TabsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final data = BrowserData.instance;
    return ListenableBuilder(
      listenable: data,
      builder: (context, _) {
        final loose = data.tabs.where((t) => t.group == null).toList();
        return Scaffold(
          appBar: AppBar(
            title: Text('${data.tabs.length} ${data.tabs.length == 1 ? 'aba' : 'abas'}'),
            actions: [
              IconButton(
                tooltip: 'Nova aba',
                icon: const Icon(Icons.add),
                onPressed: () => Navigator.pop(context, data.newTab().id),
              ),
            ],
          ),
          body: ListView(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
            children: [
              for (final group in data.groups) _GroupSection(group: group),
              if (loose.isNotEmpty) _TabGrid(tabs: loose),
            ],
          ),
        );
      },
    );
  }
}

class _GroupSection extends StatelessWidget {
  const _GroupSection({required this.group});

  final TabGroup group;

  @override
  Widget build(BuildContext context) {
    final data = BrowserData.instance;
    final color = Color(group.color);
    final inside = data.tabs.where((t) => t.group == group.id).toList();
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.fromLTRB(10, 4, 4, 10),
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(16), border: Border.all(color: color.withValues(alpha: 0.6))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Container(width: 10, height: 10, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          const SizedBox(width: 8),
          Expanded(child: Text('${group.name} · ${inside.length}', style: const TextStyle(fontWeight: FontWeight.w700))),
          IconButton(
            tooltip: 'Nova aba no grupo',
            icon: const Icon(Icons.add, size: 20),
            onPressed: () => Navigator.pop(context, data.newTab(group: group.id).id),
          ),
          PopupMenuButton<String>(
            onSelected: (action) async {
              switch (action) {
                case 'rename':
                  final name = await askName(context, 'Nome do grupo', group.name);
                  if (name != null) {
                    group.name = name;
                    data.changed();
                  }
                case 'color':
                  group.color = groupColors[(groupColors.indexOf(group.color) + 1) % groupColors.length];
                  data.changed();
                case 'ungroup':
                  data.ungroup(group.id);
                case 'close':
                  data.closeGroup(group.id);
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'rename', child: Text('Renomear')),
              PopupMenuItem(value: 'color', child: Text('Trocar a cor')),
              PopupMenuItem(value: 'ungroup', child: Text('Desagrupar')),
              PopupMenuItem(value: 'close', child: Text('Fechar o grupo')),
            ],
          ),
        ]),
        _TabGrid(tabs: inside, color: color),
      ]),
    );
  }
}

class _TabGrid extends StatelessWidget {
  const _TabGrid({required this.tabs, this.color});

  final List<BrowserTab> tabs;
  final Color? color;

  @override
  Widget build(BuildContext context) => GridView.count(
        crossAxisCount: 2,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: 8,
        crossAxisSpacing: 8,
        childAspectRatio: 1.9,
        children: [for (final tab in tabs) _TabCard(tab: tab, color: color)],
      );
}

class _TabCard extends StatelessWidget {
  const _TabCard({required this.tab, this.color});

  final BrowserTab tab;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final data = BrowserData.instance;
    final current = tab.id == data.active?.id;
    return Material(
      color: panel,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: current ? accent : lineColor, width: current ? 2 : 1)),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () {
          data.select(tab.id);
          Navigator.pop(context, tab.id);
        },
        onLongPress: () => _groupMenu(context),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 6, 0, 8),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(tab.url == null ? Icons.home_outlined : Icons.public, size: 14, color: color ?? muted),
              const SizedBox(width: 6),
              Expanded(child: Text(tab.url == null ? 'Início' : hostOf(tab.url!), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: muted, fontSize: 11))),
              SizedBox(
                width: 32,
                height: 28,
                child: IconButton(
                  padding: EdgeInsets.zero,
                  tooltip: 'Fechar aba',
                  icon: const Icon(Icons.close, size: 16),
                  onPressed: () => data.close(tab.id),
                ),
              ),
            ]),
            const SizedBox(height: 4),
            Expanded(child: Text(tab.label, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13))),
          ]),
        ),
      ),
    );
  }

  /// Holding a tab: into a group (an existing one or a new one), or out of its group.
  Future<void> _groupMenu(BuildContext context) => showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        builder: (sheet) {
          final data = BrowserData.instance;
          return SafeArea(
            child: ListView(shrinkWrap: true, children: [
              ListTile(
                leading: const Icon(Icons.create_new_folder_outlined),
                title: const Text('Novo grupo com esta aba'),
                onTap: () async {
                  Navigator.pop(sheet);
                  final name = await askName(context, 'Nome do grupo', hostOf(tab.url ?? ''));
                  if (name != null) data.moveToGroup(tab.id, data.addGroup(name).id);
                },
              ),
              for (final g in data.groups.where((g) => g.id != tab.group))
                ListTile(
                  leading: Icon(Icons.circle, color: Color(g.color), size: 16),
                  title: Text('Mover para "${g.name}"'),
                  onTap: () {
                    Navigator.pop(sheet);
                    data.moveToGroup(tab.id, g.id);
                  },
                ),
              if (tab.group != null)
                ListTile(
                  leading: const Icon(Icons.folder_off_outlined),
                  title: const Text('Tirar do grupo'),
                  onTap: () {
                    Navigator.pop(sheet);
                    data.moveToGroup(tab.id, null);
                  },
                ),
              ListTile(
                leading: const Icon(Icons.close),
                title: const Text('Fechar aba'),
                onTap: () {
                  Navigator.pop(sheet);
                  data.close(tab.id);
                },
              ),
            ]),
          );
        },
      );
}

Future<String?> askName(BuildContext context, String title, String initial) {
  final controller = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (dialog) => AlertDialog(
      title: Text(title),
      content: TextField(controller: controller, autofocus: true, onSubmitted: (v) => Navigator.pop(dialog, v.trim().isEmpty ? null : v.trim())),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialog), child: const Text('Cancelar')),
        FilledButton(onPressed: () => Navigator.pop(dialog, controller.text.trim().isEmpty ? null : controller.text.trim()), child: const Text('OK')),
      ],
    ),
  );
}

/// Favorites or history, searchable; pops with the address to open.
class SavedPagesScreen extends StatefulWidget {
  const SavedPagesScreen({super.key, required this.history});

  /// The history (by day, with clearing it); otherwise the favorites.
  final bool history;

  @override
  State<SavedPagesScreen> createState() => _SavedPagesScreenState();
}

class _SavedPagesScreenState extends State<SavedPagesScreen> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final data = BrowserData.instance;
    return ListenableBuilder(
      listenable: data,
      builder: (context, _) {
        final q = _query.toLowerCase();
        final pages = (widget.history ? data.history : data.favorites).where((p) => q.isEmpty || p.title.toLowerCase().contains(q) || p.url.toLowerCase().contains(q)).toList();
        final items = <Widget>[];
        String? day;
        for (final page in pages) {
          if (widget.history) {
            final label = _dayLabel(page.at);
            if (label != day) {
              day = label;
              items.add(Padding(padding: const EdgeInsets.fromLTRB(16, 16, 16, 4), child: Text(label, style: const TextStyle(color: muted, fontWeight: FontWeight.w700, fontSize: 12))));
            }
          }
          items.add(ListTile(
            leading: Icon(widget.history ? Icons.history : Icons.star, color: widget.history ? muted : accent),
            title: Text(page.label, maxLines: 1, overflow: TextOverflow.ellipsis),
            subtitle: Text(widget.history ? '${hostOf(page.url)} · ${_time(page.at)}' : hostOf(page.url), maxLines: 1),
            trailing: IconButton(
              tooltip: widget.history ? 'Tirar do histórico' : 'Tirar dos favoritos',
              icon: const Icon(Icons.close, size: 18),
              onPressed: () => widget.history ? data.removeVisit(page) : data.removeFavorite(page),
            ),
            onTap: () => Navigator.pop(context, page.url),
          ));
        }
        return Scaffold(
          appBar: AppBar(
            title: Text(widget.history ? 'Histórico' : 'Favoritos'),
            actions: [
              if (widget.history && data.history.isNotEmpty)
                TextButton(
                  onPressed: () async {
                    final sure = await showDialog<bool>(
                      context: context,
                      builder: (d) => AlertDialog(
                        title: const Text('Apagar todo o histórico?'),
                        actions: [
                          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancelar')),
                          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Apagar')),
                        ],
                      ),
                    );
                    if (sure == true) data.clearHistory();
                  },
                  child: const Text('Limpar'),
                ),
            ],
            bottom: PreferredSize(
              preferredSize: const Size.fromHeight(56),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: TextField(
                  decoration: const InputDecoration(hintText: 'Buscar', prefixIcon: Icon(Icons.search, size: 20), isDense: true),
                  onChanged: (v) => setState(() => _query = v),
                ),
              ),
            ),
          ),
          body: items.isEmpty
              ? Center(child: Text(widget.history ? 'Nenhuma página visitada.' : 'Nenhum favorito. Use ☆ no menu de uma página.', style: const TextStyle(color: muted)))
              : ListView.builder(itemCount: items.length, itemBuilder: (_, i) => items[i]),
        );
      },
    );
  }

  static String _dayLabel(int at) {
    final d = DateTime.fromMillisecondsSinceEpoch(at);
    final now = DateTime.now();
    final days = DateTime(now.year, now.month, now.day).difference(DateTime(d.year, d.month, d.day)).inDays;
    if (days == 0) return 'Hoje';
    if (days == 1) return 'Ontem';
    return '${d.day.toString().padLeft(2, '0')}/${d.month.toString().padLeft(2, '0')}/${d.year}';
  }

  static String _time(int at) {
    final d = DateTime.fromMillisecondsSinceEpoch(at);
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }
}
