import 'package:flutter/material.dart';

import 'api.dart';
import 'models.dart';
import 'theme.dart';

/// The options a request is translated with on the PC: its own settings, or others chosen here (the
/// vision server on the processor, another API…), as the PC's "Traduzir" screen has them.
class TranslateOptionsCard extends StatefulWidget {
  const TranslateOptionsCard({super.key, required this.api, required this.onChanged, this.title = 'Opções da tradução', this.apply, this.initial});

  final Api api;

  /// The options chosen (null: the PC's).
  final ValueChanged<Map<String, dynamic>?> onChanged;
  final String title;

  /// Done with the options right away (the whole queue's), instead of keeping them for a request to send.
  final Future<void> Function(Map<String, dynamic>? options)? apply;

  /// The options already chosen (the queue's).
  final Map<String, dynamic>? initial;

  @override
  State<TranslateOptionsCard> createState() => _TranslateOptionsCardState();
}

class _TranslateOptionsCardState extends State<TranslateOptionsCard> {
  PcTranslateSettings? _pc;
  late Map<String, dynamic>? _options = widget.initial;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final pc = await widget.api.translateSettings();
      if (mounted) setState(() => (_pc = pc, _error = null));
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _edit() async {
    final pc = _pc;
    if (pc == null) return;
    final result = await showModalBottomSheet<({Map<String, dynamic>? options, bool asDefault})>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _OptionsSheet(pc: pc, start: {...pc.defaults, ...?_options}, applyLabel: widget.apply != null ? 'Aplicar à fila' : 'Usar'),
    );
    if (result == null) return;
    try {
      if (result.asDefault && result.options != null) {
        await widget.api.saveTranslateDefaults(result.options!);
        await _load();
      }
      // Saved as the defaults: the request goes with them anyway.
      final options = result.asDefault ? null : result.options;
      await widget.apply?.call(options);
      setState(() => _options = options);
      widget.onChanged(options);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final pc = _pc;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 10, 6, 10),
      decoration: BoxDecoration(color: panel, borderRadius: BorderRadius.circular(14), border: Border.all(color: lineColor)),
      child: Row(children: [
        const Icon(Icons.tune, color: muted),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(widget.title, style: const TextStyle(fontWeight: FontWeight.w700)),
            Text(
              _error ?? (pc == null ? 'Lendo as do PC…' : '${_options == null ? 'As do PC' : 'Escolhidas aqui'}: ${pc.summary({...pc.defaults, ...?_options})}'),
              style: TextStyle(color: _error != null ? Theme.of(context).colorScheme.error : muted, fontSize: 12),
            ),
          ]),
        ),
        TextButton(onPressed: pc == null ? (_error != null ? _load : null) : _edit, child: Text(_error != null ? 'Tentar' : 'Mudar')),
      ]),
    );
  }
}

class _OptionsSheet extends StatefulWidget {
  const _OptionsSheet({required this.pc, required this.start, required this.applyLabel});

  final PcTranslateSettings pc;
  final Map<String, dynamic> start;
  final String applyLabel;

  @override
  State<_OptionsSheet> createState() => _OptionsSheetState();
}

class _OptionsSheetState extends State<_OptionsSheet> {
  late final Map<String, dynamic> _o = {...widget.start};
  bool _asDefault = false;

  void _set(String key, Object? value) => setState(() => _o[key] = value);

  Widget _pick<T>(String label, String key, Map<T, String> choices) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: DropdownButtonFormField<T>(
          initialValue: choices.containsKey(_o[key]) ? _o[key] as T : null,
          isExpanded: true,
          decoration: InputDecoration(labelText: label),
          items: [for (final e in choices.entries) DropdownMenuItem(value: e.key, child: Text(e.value, overflow: TextOverflow.ellipsis))],
          onChanged: (v) => _set(key, v),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final pc = widget.pc;
    final profile = pc.profiles.where((p) => p.id == _o['activeProfileId']).firstOrNull;
    final languages = {for (final l in pc.languages) l.value: l.label};
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Opções da tradução', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 14),
          _pick('Visão (achar e apagar o texto) em', 'visionDevice', const {'gpu': 'Placa de vídeo (GPU)', 'cpu': 'Processador (deixa a GPU livre)'}),
          if (_o['visionDevice'] == 'cpu')
            const Padding(
              padding: EdgeInsets.only(bottom: 12),
              child: Text('No processador cada página leva minutos em vez de segundos.', style: TextStyle(color: muted, fontSize: 12)),
            ),
          _pick('API', 'activeProfileId', {for (final p in pc.profiles) p.id: '${p.name} · ${p.model.isEmpty ? 'sem modelo' : p.model}${p.ready ? '' : ' (sem chave)'}'}),
          if (profile?.local == true) _pick('Modelo de tradução local em', 'aiDevice', const {'gpu': 'Placa de vídeo (GPU)', 'cpu': 'Processador e RAM'}),
          _pick('Velocidade', 'speed', PcTranslateSettings.speeds),
          _pick('Idioma original', 'sourceLanguage', {pc.auto: 'Detectar automaticamente', ...languages}),
          _pick('Traduzir para', 'targetLanguage', languages),
          _pick('Uso da GPU', 'gpuSharing', PcTranslateSettings.gpuSharing),
          _pick('Páginas ao mesmo tempo', 'concurrency', {for (final n in [1, 2, 3, 4, 5, 6, 8]) n: '$n'}),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Traduzir onomatopeias'),
            value: _o['translateSfx'] == true,
            onChanged: (v) => _set('translateSfx', v),
          ),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Salvar como padrão do PC'),
            subtitle: const Text('Vale para tudo que o PC traduzir depois', style: TextStyle(fontSize: 12)),
            value: _asDefault,
            onChanged: (v) => setState(() => _asDefault = v == true),
          ),
          const SizedBox(height: 8),
          Row(children: [
            TextButton(onPressed: () => Navigator.pop(context, (options: null, asDefault: false)), child: const Text('Usar as do PC')),
            const Spacer(),
            FilledButton(onPressed: () => Navigator.pop(context, (options: _o, asDefault: _asDefault)), child: Text(widget.applyLabel)),
          ]),
        ]),
      ),
    );
  }
}
