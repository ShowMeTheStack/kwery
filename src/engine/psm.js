// The procedural languages: PL/pgSQL as PostgreSQL runs it, and the SQL/PSM forms of the standard the course
// uses (BEGIN ... END with DECLARE, SET, WHILE ... DO, REPEAT ... UNTIL, FOR ... AS ... DO, handlers). A body is
// parsed once into a tree of statements. Expressions and queries inside it are ordinary SQL: they are bound with
// the variables in scope (a variable reads its slot in the running frame) and their plans are cached on the tree.
// Every statement gets its own command id, so it sees what the statements before it did; an EXCEPTION block runs
// as a subtransaction, so a caught error undoes the block's changes, as in PostgreSQL.
(function (root) {
  'use strict';
  const K = root.K;
  const S = K.STATE;
  const B = () => K.T.BASE;
  const T = () => K.T;
  const EMPTY = [];

  // ---- condition names (PostgreSQL's errcodes) ---------------------------------------------------------------------
  const CONDITIONS = {
    successful_completion: '00000', warning: '01000', no_data: '02000', sql_statement_not_yet_complete: '03000', connection_exception: '08000',
    triggered_action_exception: '09000', feature_not_supported: '0A000', invalid_transaction_initiation: '0B000', locator_exception: '0F000',
    invalid_grantor: '0L000', invalid_role_specification: '0P000', diagnostics_exception: '0Z000', stacked_diagnostics_accessed_without_active_handler: '0Z002',
    case_not_found: '20000', cardinality_violation: '21000', data_exception: '22000', array_subscript_error: '2202E', character_not_in_repertoire: '22021',
    datetime_field_overflow: '22008', division_by_zero: '22012', error_in_assignment: '22005', escape_character_conflict: '2200B', indicator_overflow: '22022',
    interval_field_overflow: '22015', invalid_argument_for_logarithm: '2201E', invalid_argument_for_ntile_function: '22014', invalid_argument_for_nth_value_function: '22016',
    invalid_argument_for_power_function: '2201F', invalid_argument_for_width_bucket_function: '2201G', invalid_character_value_for_cast: '22018',
    invalid_datetime_format: '22007', invalid_escape_character: '22019', invalid_escape_octet: '2200D', invalid_escape_sequence: '22025',
    invalid_indicator_parameter_value: '22010', invalid_parameter_value: '22023', invalid_preceding_or_following_size: '22013', invalid_regular_expression: '2201B',
    invalid_row_count_in_limit_clause: '2201W', invalid_row_count_in_result_offset_clause: '2201X', invalid_time_zone_displacement_value: '22009',
    invalid_use_of_escape_character: '2200C', most_specific_type_mismatch: '2200G', null_value_not_allowed: '22004', null_value_no_indicator_parameter: '22002',
    numeric_value_out_of_range: '22003', sequence_generator_limit_exceeded: '2200H', string_data_length_mismatch: '22026', string_data_right_truncation: '22001',
    substring_error: '22011', trim_error: '22027', unterminated_c_string: '22024', zero_length_character_string: '2200F', floating_point_exception: '22P01',
    invalid_text_representation: '22P02', invalid_binary_representation: '22P03', bad_copy_file_format: '22P04', untranslatable_character: '22P05',
    invalid_json_text: '22032', integrity_constraint_violation: '23000', restrict_violation: '23001', not_null_violation: '23502', foreign_key_violation: '23503',
    unique_violation: '23505', check_violation: '23514', exclusion_violation: '23P01', invalid_cursor_state: '24000', invalid_transaction_state: '25000',
    active_sql_transaction: '25001', read_only_sql_transaction: '25006', no_active_sql_transaction: '25P01', in_failed_sql_transaction: '25P02',
    invalid_sql_statement_name: '26000', triggered_data_change_violation: '27000', invalid_authorization_specification: '28000',
    dependent_privilege_descriptors_still_exist: '2B000', dependent_objects_still_exist: '2BP01', invalid_transaction_termination: '2D000', sql_routine_exception: '2F000',
    function_executed_no_return_statement: '2F005', modifying_sql_data_not_permitted: '2F002', prohibited_sql_statement_attempted: '2F003',
    reading_sql_data_not_permitted: '2F004', invalid_cursor_name: '34000', external_routine_exception: '38000', external_routine_invocation_exception: '39000',
    savepoint_exception: '3B000', invalid_savepoint_specification: '3B001', invalid_catalog_name: '3D000', invalid_schema_name: '3F000',
    transaction_rollback: '40000', transaction_integrity_constraint_violation: '40002', serialization_failure: '40001', statement_completion_unknown: '40003',
    deadlock_detected: '40P01', syntax_error_or_access_rule_violation: '42000', syntax_error: '42601', insufficient_privilege: '42501', cannot_coerce: '42846',
    grouping_error: '42803', windowing_error: '42P20', invalid_recursion: '42P19', invalid_foreign_key: '42830', invalid_name: '42602', name_too_long: '42622',
    reserved_name: '42939', datatype_mismatch: '42804', indeterminate_datatype: '42P18', collation_mismatch: '42P21', indeterminate_collation: '42P22',
    wrong_object_type: '42809', undefined_column: '42703', undefined_function: '42883', undefined_table: '42P01', undefined_parameter: '42P02',
    undefined_object: '42704', duplicate_column: '42701', duplicate_cursor: '42P03', duplicate_database: '42P04', duplicate_function: '42723',
    duplicate_prepared_statement: '42P05', duplicate_schema: '42P06', duplicate_table: '42P07', duplicate_alias: '42712', duplicate_object: '42710',
    ambiguous_column: '42702', ambiguous_function: '42725', ambiguous_parameter: '42P08', ambiguous_alias: '42P09', invalid_column_reference: '42P10',
    invalid_column_definition: '42611', invalid_cursor_definition: '42P11', invalid_database_definition: '42P12', invalid_function_definition: '42P13',
    invalid_prepared_statement_definition: '42P14', invalid_schema_definition: '42P15', invalid_table_definition: '42P16', invalid_object_definition: '42P17',
    with_check_option_violation: '44000', insufficient_resources: '53000', disk_full: '53100', out_of_memory: '53200', too_many_connections: '53300',
    program_limit_exceeded: '54000', statement_too_complex: '54001', too_many_columns: '54011', object_not_in_prerequisite_state: '55000',
    object_in_use: '55006', cant_change_runtime_param: '55P02', lock_not_available: '55P03', operator_intervention: '57000', query_canceled: '57014',
    system_error: '58000', plpgsql_error: 'P0000', raise_exception: 'P0001', no_data_found: 'P0002', too_many_rows: 'P0003', assert_failure: 'P0004',
    internal_error: 'XX000', data_corrupted: 'XX001', index_corrupted: 'XX002',
  };
  const CODE_NAMES = new Map(Object.entries(CONDITIONS).map(([k, v]) => [v, k]));
  const LEVELS = ['debug', 'log', 'info', 'notice', 'warning', 'exception'];
  const DIAG = ['row_count', 'pg_context', 'pg_routine_oid'];
  const STACKED = ['returned_sqlstate', 'column_name', 'constraint_name', 'pg_datatype_name', 'message_text', 'table_name', 'schema_name', 'pg_exception_detail', 'pg_exception_hint', 'pg_exception_context'];
  const QUERY_START = new Set(['select', 'with', 'values', 'table']);
  const DML_START = new Set(['insert', 'update', 'delete', 'merge']);
  const MAX_STEPS = 5000000;

  const synErr = (msg, pos) => K.err(S.syntax, msg, { pos });
  const isComposite = (t) => !!(t && t.cat === 'C' && t.fields);
  const recType = (cols) => ({ id: 'record', name: 'record', cat: 'C', len: -1, fields: cols.map((c) => ({ name: c.name, type: c.type })) });
  const tkey = (t) => (!t ? '-' : t.fields ? (t.id === 'record' ? '' : t.id) + '(' + t.fields.map((f) => f.name + ' ' + tkey(f.type)).join(',') + ')' : t.id + (t.n !== undefined ? '(' + t.n + ')' : '') + (t.elem ? '[' + tkey(t.elem) + ']' : ''));
  /** drain a generator that is not expected to wait (procedural code runs synchronously) */
  function drain(gen) {
    for (let x = gen.next(); !x.done; x = gen.next()) {
      const sig = x.value;
      if (sig && sig.signal === 'wait' && !(sig.ready && sig.ready())) throw K.err(S.lockNotAvailable, 'a statement in a function would wait: ' + sig.why, { hint: 'Statements inside functions and procedures cannot wait for locks held by other sessions here.' });
    }
    return undefined;
  }
  function drainValue(gen) {
    for (;;) {
      const x = gen.next();
      if (x.done) return x.value;
      const sig = x.value;
      if (sig && sig.signal === 'wait' && !(sig.ready && sig.ready())) throw K.err(S.lockNotAvailable, 'a statement in a function would wait: ' + sig.why, { hint: 'Statements inside functions and procedures cannot wait for locks held by other sessions here.' });
    }
  }

  // ---- scopes -------------------------------------------------------------------------------------------------
  // A scope maps names to slot numbers; a block's label (and the function's name, for the outermost scope) can
  // qualify its variables. Scopes exist at parse time; the slots live in the frame of each call.
  const newScope = (parent, label) => ({ vars: new Map(), labels: label ? [label] : [], parent });
  function lookupVar(sc, name) { for (let s = sc; s; s = s.parent) { const i = s.vars.get(name); if (i !== undefined) return i; } return -1; }
  function lookupLabel(sc, name) { for (let s = sc; s; s = s.parent) if (s.labels.includes(name)) return s; return null; }
  function resolveParts(sc, parts) {
    if (parts.length > 1) {
      const blk = lookupLabel(sc, parts[0]);
      if (blk && blk.vars.has(parts[1])) return { slot: blk.vars.get(parts[1]), fields: parts.slice(2) };
    }
    const i = lookupVar(sc, parts[0]);
    return i < 0 ? null : { slot: i, fields: parts.slice(1) };
  }

  // ---- the parser ---------------------------------------------------------------------------------------------------
  class PLParser {
    constructor(f, iso) {
      this.f = f;
      this.iso = iso;
      this.src = f.body;
      this.p = new K.Parser(f.body);
      this.slots = [];
      this.loops = [];          // enclosing labels and loops, for EXIT and CONTINUE
      this.trigger = !!(f.retType && f.retType.id === 'trigger');
      this.caseN = 0;
    }
    get t() { return this.p.tok; }
    is(w, k) { return this.p.isKw(w, k); }
    eat(...w) { return this.p.eatKw(...w); }
    kw(...w) { this.p.kw(...w); }
    isOp(o, k) { return this.p.isOp(o, k); }
    eatOp(o) { return this.p.eatOp(o); }
    op(o) { this.p.op(o); }
    fail(msg, tok) { this.p.fail(msg, tok); }
    near(t) { t = t || this.t; return t.t === 'eof' ? 'end of input' : '"' + this.src.slice(t.pos, t.end) + '"'; }
    word() { const t = this.t; return t.t === 'id' && !t.quoted ? t.v : null; }
    semi() { if (this.eatOp(';') || this.t.t === 'eof') return; if (this.iso && this.isEndish()) return; this.fail('syntax error at or near ' + this.near()); }
    isEndish() { return ['end', 'else', 'elseif', 'elsif', 'until', 'when'].some((w) => this.is(w)); }
    line(pos) { let n = 1; for (let i = 0; i < pos && i < this.src.length; i++) if (this.src.charCodeAt(i) === 10) n++; return n; }
    addSlot(sc, name, info) {
      const i = this.slots.length;
      this.slots.push(Object.assign({ i, name, kind: 'scalar' }, info));
      if (name !== null && name !== undefined) sc.vars.set(name, i);
      return i;
    }

    // ---- the whole body ----
    parse() {
      const f = this.f;
      const rootSc = newScope(null, f.name);
      this.root = rootSc;
      const params = [];
      let n = 0;
      for (const p of f.params) {
        n++;
        const i = this.addSlot(rootSc, p.name || null, { kind: p.type && p.type.cat === 'P' && p.type.id !== 'unknown' ? 'auto' : isComposite(p.type) ? 'row' : 'scalar', spec: { type: p.type }, param: p.mode, argIndex: p.mode === 'out' ? -1 : params.filter((x) => x.mode !== 'out').length });
        rootSc.vars.set('$' + n, i);
        params.push({ slot: i, mode: p.mode });
      }
      const outs = params.filter((p) => p.mode === 'out' || p.mode === 'inout').map((p) => p.slot);
      if (f.returnsTable && f.retType && f.retType.fields) for (const c of f.retType.fields) outs.push(this.addSlot(rootSc, c.name, { kind: isComposite(c.type) ? 'row' : 'scalar', spec: { type: c.type }, param: 'out' }));
      this.found = this.addSlot(rootSc, 'found', { spec: { type: B().bool }, init: false });
      if (this.trigger) {
        const tg = {};
        tg.new = this.addSlot(rootSc, 'new', { kind: 'record', spec: { record: true } });
        tg.old = this.addSlot(rootSc, 'old', { kind: 'record', spec: { record: true } });
        for (const [k, t] of [['tg_name', 'name'], ['tg_when', 'text'], ['tg_level', 'text'], ['tg_op', 'text'], ['tg_relid', 'oid'], ['tg_relname', 'name'], ['tg_table_name', 'name'], ['tg_table_schema', 'name'], ['tg_nargs', 'int4'], ['tg_argv', 'text[]']]) tg[k] = this.addSlot(rootSc, k, { spec: { type: T().byName(t) || B().text } });
        this.tg = tg;
      }
      let body;
      if (this.iso) {
        if (this.is('begin') || (this.t.t === 'id' && this.isOp(':', 1) && this.is('begin', 2))) body = this.stmt(rootSc);
        else {
          const b = { k: 'block', scope: newScope(rootSc, null), decls: [], body: [], pos: 0 };
          this.isoDecls(b);
          b.body = this.stmts(b.scope, []);
          body = b;
        }
        while (this.eatOp(';'));
      } else {
        let label = null;
        if (this.isOp('<<')) { this.p.i++; label = this.p.label(); this.op('>>'); }
        if (!this.is('declare') && !this.is('begin')) this.fail('syntax error at or near ' + this.near());
        body = this.block(rootSc, label);
      }
      if (this.t.t !== 'eof') this.fail('syntax error at or near ' + this.near());
      return { body, slots: this.slots, params, outs, found: this.found, tg: this.tg || null, iso: this.iso, line: (p) => this.line(p) };
    }

    // ---- blocks ----
    block(sc, label) {
      const pos = this.t.pos;
      const bsc = newScope(sc, label);
      const b = { k: 'block', label, scope: bsc, decls: [], body: null, handlers: null, pos };
      if (this.eat('declare')) {
        while (!this.is('begin')) {
          if (this.t.t === 'eof') this.fail('syntax error at end of input');
          if (this.eat('declare')) continue;
          this.decl(bsc, b.decls);
        }
      }
      this.kw('begin');
      this.loops.push({ label, loop: false });
      b.body = this.stmts(bsc, ['exception', 'end']);
      this.loops.pop();
      if (this.eat('exception')) {
        b.handlers = [];
        if (!this.is('when')) this.fail('syntax error at or near ' + this.near());
        while (this.eat('when')) {
          const hsc = newScope(bsc, null);
          const h = { conds: this.conds(), scope: hsc };
          h.state = this.addSlot(hsc, 'sqlstate', { spec: { type: B().text } });
          h.errm = this.addSlot(hsc, 'sqlerrm', { spec: { type: B().text } });
          this.kw('then');
          this.loops.push({ label, loop: false });
          h.body = this.stmts(hsc, ['when', 'end']);
          this.loops.pop();
          b.handlers.push(h);
        }
      }
      this.kw('end');
      this.endLabel(label);
      this.semi();
      return b;
    }
    endLabel(label) {
      const t = this.t;
      if (t.t === 'id' && !this.isOp(';') && (!K.RESERVED.has(t.v) || t.v === label)) {
        if (t.v !== label) throw synErr(label ? 'end label "' + t.v + '" differs from block\'s label "' + label + '"' : 'end label "' + t.v + '" specified for unlabeled block', t.pos);
        this.p.i++;
      }
    }
    conds() {
      const out = [];
      do {
        if (this.eat('sqlstate')) { const t = this.t; if (t.t !== 'str') this.fail(); this.p.i++; if (!/^[0-9A-Z]{5}$/.test(t.v)) throw synErr('invalid SQLSTATE code', t.pos); out.push({ code: t.v }); continue; }
        if (this.iso && this.eat('sqlexception')) { out.push({ sqlexception: true }); continue; }
        if (this.iso && this.eat('sqlwarning')) { out.push({ code: '01000' }); continue; }
        if (this.iso && this.eat('not', 'found')) { out.push({ code: '02000' }); continue; }
        const t = this.t;
        const name = this.p.label();
        if (name === 'others') { out.push({ others: true }); continue; }
        if (this.iso && this.condNames && this.condNames.has(name)) { out.push({ code: this.condNames.get(name) }); continue; }
        if (!CONDITIONS[name]) throw K.err(S.undefinedObject, 'unrecognized exception condition "' + name + '"', { pos: t.pos });
        out.push({ code: CONDITIONS[name] });
      } while (this.eat('or') || (this.iso && this.eatOp(',')));
      return out;
    }

    // ---- declarations ----
    decl(sc, decls) {
      const pos = this.t.pos;
      const nameTok = this.t;
      const name = this.declName();
      // name ALIAS FOR $n | name
      if (this.eat('alias', 'for')) {
        const t = this.t;
        let i;
        if (t.t === 'param') { this.p.i++; i = this.root.vars.get('$' + t.v); if (i === undefined) throw synErr('there is no parameter $' + t.v, t.pos); }
        else { const n = this.p.name(); i = lookupVar(sc, n); if (i < 0) throw synErr('variable "' + n + '" does not exist', t.pos); }
        sc.vars.set(name, i);
        this.semi();
        return;
      }
      // name [NO] SCROLL CURSOR [(args)] FOR query
      let scroll;
      if (this.is('no') && this.is('scroll', 1)) { this.p.i += 2; scroll = false; } else if (this.is('scroll') && this.is('cursor', 1)) { this.p.i++; scroll = true; }
      if (this.eat('cursor')) {
        const csc = newScope(sc, null);
        const args = [];
        if (this.eatOp('(')) {
          do { const an = this.declName(); const spec = this.declType(); args.push(this.addSlot(csc, an, { spec, kind: spec.rowOf ? 'row' : 'scalar' })); } while (this.eatOp(','));
          this.op(')');
        }
        if (!this.eat('for')) this.kw('is');
        const q = this.sql(csc, { until: [';'], noInto: true, query: true });
        this.semi();
        const i = this.addSlot(sc, name, { spec: { type: B().text }, cursor: { query: q, args, scroll }, init: name });
        decls.push(i);
        return;
      }
      const constant = this.eat('constant');
      const spec = this.declType();
      if (this.eat('collate')) this.p.label();
      const notNull = this.eat('not', 'null');
      let def = null;
      if (this.eat('default') || this.eatOp(':=') || this.eatOp('=')) def = this.expr(sc, [';']);
      this.semi();
      if (notNull && !def) throw K.err('22004', 'variable "' + name + '" must have a default value, since it\'s declared NOT NULL', { pos: nameTok.pos });
      const kind = spec.record ? 'record' : spec.rowOf || (spec.type && isComposite(spec.type)) ? 'row' : 'scalar';
      const i = this.addSlot(sc, name, { spec, kind, constant, notNull, def, compositeMaybe: !!spec.ast || !!spec.copyOf });
      decls.push(i);
    }
    declName() { const t = this.t; if (t.t !== 'id') this.fail('syntax error at or near ' + this.near()); this.p.i++; return t.v; }
    declType() {
      if (this.t.t === 'id') {
        const parts = [this.t.v];
        let j = 1;
        while (this.isOp('.', j) && this.p.peek(j + 1).t === 'id') { parts.push(this.p.peek(j + 1).v); j += 2; }
        if (this.isOp('%', j) && this.p.peek(j + 1).t === 'id' && (this.p.peek(j + 1).v === 'type' || this.p.peek(j + 1).v === 'rowtype')) {
          const which = this.p.peek(j + 1).v;
          const pos = this.t.pos;
          this.p.i += j + 2;
          return which === 'type' ? { copyOf: parts, pos } : { rowOf: parts, pos };
        }
      }
      if (this.eat('record')) return { record: true };
      if (this.eat('refcursor')) return { type: B().text, refcursor: true };
      const pos = this.t.pos;
      const ast = this.p.typeName();
      return { ast, pos };
    }
    /** SQL/PSM declarations at the start of a compound statement */
    isoDecls(b) {
      const sc = b.scope;
      while (this.is('declare')) {
        this.p.i++;
        if (this.is('continue') || this.is('exit') || this.is('undo')) {
          const how = this.word(); this.p.i++;
          this.kw('handler', 'for');
          const conds = this.conds();
          const hsc = newScope(sc, null);
          this.loops.push({ label: null, loop: false });
          const body = [this.stmt(hsc)];
          this.loops.pop();
          (b.isoHandlers || (b.isoHandlers = [])).push({ how, conds, body, scope: hsc });
          continue;
        }
        const names = [this.declName()];
        if (this.eat('condition')) {
          let code = '45000';
          if (this.eat('for')) { this.kw('sqlstate'); this.eat('value'); code = this.t.v; this.p.i++; }
          (this.condNames || (this.condNames = new Map())).set(names[0], code);
          this.semi();
          continue;
        }
        if (this.is('cursor') || (this.is('scroll') && this.is('cursor', 1)) || (this.is('insensitive') && this.is('cursor', 1))) {
          if (!this.is('cursor')) this.p.i++;
          this.kw('cursor');
          if (this.eat('with', 'hold') || this.eat('without', 'hold')) { /* accepted */ }
          this.kw('for');
          const q = this.sql(sc, { until: [';'], noInto: true, query: true });
          this.semi();
          b.decls.push(this.addSlot(sc, names[0], { spec: { type: B().text }, cursor: { query: q, args: [], scroll: true }, init: names[0] }));
          continue;
        }
        while (this.eatOp(',')) names.push(this.declName());
        const spec = this.declType();
        let def = null;
        if (this.eat('default')) def = this.expr(sc, [';']);
        this.semi();
        const kind = spec.record ? 'record' : spec.rowOf ? 'row' : 'scalar';
        for (const n of names) b.decls.push(this.addSlot(sc, n, { spec, kind, def, compositeMaybe: !!spec.ast }));
      }
    }
    compound(sc, label) {
      const pos = this.t.pos;
      this.kw('begin');
      this.eat('atomic') || this.eat('not', 'atomic');
      const b = { k: 'block', label, scope: newScope(sc, label), decls: [], body: null, handlers: null, pos };
      this.isoDecls(b);
      this.loops.push({ label, loop: false });
      b.body = this.stmts(b.scope, ['end']);
      this.loops.pop();
      this.kw('end');
      this.endLabel(label);
      this.semi();
      return b;
    }

    // ---- statements ----
    stmts(sc, ends) {
      const out = [];
      while (!ends.some((e) => this.is(e))) {
        if (this.t.t === 'eof') { if (!ends.length) break; this.fail('syntax error at end of input'); }
        if (this.eatOp(';')) continue;
        out.push(this.stmt(sc));
      }
      return out;
    }
    stmt(sc) {
      const pos = this.t.pos;
      let label = null;
      if (this.isOp('<<')) { this.p.i++; label = this.p.label(); this.op('>>'); }
      else if (this.iso && this.t.t === 'id' && this.isOp(':', 1)) { label = this.t.v; this.p.i += 2; }
      const w = this.word();
      let s = null;
      switch (w) {
        case 'declare': if (!this.iso) s = this.block(sc, label); break;
        case 'begin': s = this.iso ? this.compound(sc, label) : this.block(sc, label); break;
        case 'loop': s = this.loopStmt(sc, label); break;
        case 'while': s = this.whileStmt(sc, label); break;
        case 'repeat': if (this.iso) s = this.repeatStmt(sc, label); break;
        case 'for': s = this.forStmt(sc, label); break;
        case 'foreach': s = this.foreachStmt(sc, label); break;
      }
      if (!s && label) throw synErr('syntax error at or near ' + this.near(), this.t.pos);
      if (!s) {
        switch (w) {
          case 'if': s = this.ifStmt(sc); break;
          case 'case': s = this.caseStmt(sc); break;
          case 'exit': case 'continue': s = this.exitStmt(w === 'continue', sc); break;
          case 'leave': case 'iterate': if (this.iso) s = this.exitStmt(w === 'iterate', sc); break;
          case 'return': s = this.returnStmt(sc); break;
          case 'raise': s = this.raiseStmt(sc); break;
          case 'signal': case 'resignal': if (this.iso) s = this.signalStmt(sc, w === 'resignal'); break;
          case 'assert': { this.p.i++; const cond = this.expr(sc, [';', ',']); let msg = null; if (this.eatOp(',')) msg = this.expr(sc, [';']); this.semi(); s = { k: 'assert', cond, msg }; break; }
          case 'perform': { this.p.i++; s = this.sql(sc, { until: [';'], perform: true }); this.semi(); break; }
          case 'execute': s = this.executeStmt(sc); break;
          case 'get': if (this.is('diagnostics', 1) || ((this.is('current', 1) || this.is('stacked', 1)) && this.is('diagnostics', 2))) s = this.getDiag(sc); break;
          case 'open': s = this.openStmt(sc); break;
          case 'fetch': case 'move': s = this.fetchStmt(sc, w === 'move'); break;
          case 'close': { this.p.i++; const c = this.cursorRef(sc); this.semi(); s = { k: 'close', cur: c }; break; }
          case 'null': if (this.isOp(';', 1)) { this.p.i += 2; s = { k: 'null' }; } break;
          case 'commit': case 'rollback': {
            if (this.is('to', 1) || this.is('prepared', 1)) break;
            this.p.i++; this.eat('work') || this.eat('transaction');
            let chain = false;
            if (this.eat('and')) { chain = !this.eat('no'); this.kw('chain'); }
            this.semi();
            s = { k: w, chain };
            break;
          }
          case 'call': s = this.sql(sc, { until: [';'], call: true }); this.semi(); break;
          case 'set': if (this.iso) s = this.isoSet(sc); break;
        }
      }
      if (!s) s = this.assignOrSql(sc);
      s.pos = pos;
      s.line = this.line(pos);
      return s;
    }
    assignOrSql(sc) {
      if (this.t.t === 'id') {
        const save = this.p.i;
        const tgt = this.target(sc, true);
        if (tgt && (this.isOp(':=') || this.isOp('='))) {
          this.p.i++;
          this.checkConst(tgt);
          const e = this.expr(sc, [';']);
          this.semi();
          return { k: 'assign', target: tgt, expr: e };
        }
        this.p.i = save;
      }
      const s = this.sql(sc, { until: [';'] });
      this.semi();
      return s;
    }
    checkConst(tgt) { const info = this.slots[tgt.slot]; if (info.constant) throw K.err('22005', 'variable "' + info.name + '" is declared CONSTANT', { pos: this.t.pos }); }
    isoSet(sc) {
      const save = this.p.i;
      this.p.i++;
      const tgt = this.target(sc, true);
      if (tgt && this.isOp('=')) { this.p.i++; const e = this.expr(sc, [';']); this.semi(); return { k: 'assign', target: tgt, expr: e }; }
      this.p.i = save;
      return null;
    }
    /** an assignment target: a variable, a record field, an array element */
    target(sc, quiet) {
      const t = this.t;
      if (t.t !== 'id') { if (quiet) return null; this.fail('syntax error at or near ' + this.near()); }
      const parts = [t.v];
      let j = 1;
      while (this.isOp('.', j) && this.p.peek(j + 1).t === 'id') { parts.push(this.p.peek(j + 1).v); j += 2; }
      const hit = resolveParts(sc, parts);
      if (!hit) { if (quiet) return null; throw synErr('"' + parts.join('.') + '" is not a known variable', t.pos); }
      const info = this.slots[hit.slot];
      if (hit.fields.length && info.kind === 'scalar' && !info.compositeMaybe) { if (quiet) return null; throw synErr('"' + parts.join('.') + '" is not a known variable', t.pos); }
      this.p.i += j;
      const path = hit.fields.map((f) => ({ field: f }));
      while (this.isOp('[')) {
        this.p.i++;
        const e = this.expr(sc, [']']);
        this.op(']');
        path.push({ idx: e });
      }
      return { slot: hit.slot, path, name: parts.join('.'), pos: t.pos };
    }
    targets(sc) {
      const out = [this.target(sc)];
      while (this.eatOp(',')) out.push(this.target(sc));
      for (const t of out) this.checkConst(t);
      return out;
    }

    // ---- expressions and SQL ----
    /** the text of an expression up to one of the end tokens (at nesting depth zero), parsed as SELECT expr */
    expr(sc, ends) {
      const start = this.p.i;
      let depth = 0, cdepth = 0;
      for (;;) {
        const t = this.t;
        if (t.t === 'eof') break;
        if (depth === 0 && cdepth === 0 && ends.some((e) => (e.length === 1 || e === '..' || e === ':=' ? t.t === 'op' && t.v === e : t.t === 'id' && !t.quoted && t.v === e))) break;
        if (t.t === 'op' && (t.v === '(' || t.v === '[')) depth++;
        else if (t.t === 'op' && (t.v === ')' || t.v === ']')) { if (depth === 0) break; depth--; }
        else if (t.t === 'op' && t.v === ';' && depth === 0) break;
        else if (this.iso && t.t === 'id' && !t.quoted && t.v === 'case') cdepth++;
        else if (this.iso && t.t === 'id' && !t.quoted && t.v === 'end' && cdepth > 0) cdepth--;
        this.p.i++;
      }
      if (this.p.i === start) this.fail('syntax error at or near ' + this.near());
      const pos = this.p.toks[start].pos;
      return this.mkExpr(sc, this.src.slice(pos, this.t.pos), pos);
    }
    mkExpr(sc, text, pos) {
      let stmts;
      try { stmts = K.parse('select ' + text); } catch (e) { if (e.pos !== undefined) e.pos = pos + Math.max(0, e.pos - 7); throw e; }
      if (stmts.length !== 1) throw synErr('syntax error at or near ";"', pos);
      paramsToNames(stmts[0]);
      return { k: 'expr', text: text.trim(), ast: stmts[0], scope: sc, pos };
    }
    /** a SQL statement up to the end token; INTO targets are taken out (as PL/pgSQL does) */
    sql(sc, opts) {
      const start = this.p.i;
      let depth = 0, cdepth = 0;
      const ends = opts.until;
      for (;;) {
        const t = this.t;
        if (t.t === 'eof') break;
        if (t.t === 'op' && (t.v === '(' || t.v === '[')) depth++;
        else if (t.t === 'op' && (t.v === ')' || t.v === ']')) depth--;
        else if (t.t === 'id' && !t.quoted && t.v === 'case') cdepth++;
        else if (t.t === 'id' && !t.quoted && t.v === 'end' && cdepth > 0) { cdepth--; this.p.i++; continue; }
        if (depth <= 0 && cdepth === 0 && ends.some((e) => (e === ';' ? t.t === 'op' && t.v === ';' : t.t === 'id' && !t.quoted && t.v === e))) break;
        if (this.iso && depth <= 0 && cdepth === 0 && t.t === 'id' && !t.quoted && ['end', 'else', 'elseif', 'until'].includes(t.v) && this.p.i > start) break;
        this.p.i++;
      }
      const end = this.p.i;
      if (end === start) this.fail('syntax error at or near ' + this.near());
      const toks = this.p.toks;
      const first = opts.perform ? 'select' : toks[start].v;
      const isQuery = QUERY_START.has(first) || (toks[start].t === 'op' && toks[start].v === '(');
      const isDml = DML_START.has(first);
      let into = null, cut = null;
      if (!opts.noInto && (isQuery || isDml)) {
        let d = 0, sawReturning = false;
        for (let k = start; k < end; k++) {
          const t = toks[k];
          if (t.t === 'op' && (t.v === '(' || t.v === '[')) d++;
          else if (t.t === 'op' && (t.v === ')' || t.v === ']')) d--;
          if (d !== 0 || t.t !== 'id' || t.quoted) continue;
          if (t.v === 'returning') sawReturning = true;
          if (t.v !== 'into') continue;
          const prev = toks[k - 1];
          if (prev && prev.t === 'id' && (prev.v === 'insert' || prev.v === 'merge')) continue;
          if (isDml && !sawReturning) continue;
          // INTO [STRICT] target [, target ...]
          const save = this.p.i;
          this.p.i = k + 1;
          const strict = this.eat('strict');
          const targets = this.targets(sc);
          cut = [k, this.p.i];
          this.p.i = save;
          into = { targets, strict };
          break;
        }
      }
      const piece = (a, b) => (a < b ? this.src.slice(toks[a].pos, toks[b - 1].end) : '');
      let text = cut ? piece(start, cut[0]) + ' ' + piece(cut[1], end) : piece(start, end);
      if (opts.perform) text = 'select ' + text;
      const pos = toks[start].pos;
      let ast;
      try { ast = K.parse(text); } catch (e) { if (e.pos !== undefined) e.pos = pos + e.pos; throw e; }
      if (ast.length !== 1) throw synErr('syntax error at or near ";"', pos);
      ast = ast[0];
      paramsToNames(ast);
      const kind = opts.call ? 'call' : ast.type === 'select' || ast.type === 'values' || ast.type === 'setop' ? 'query' : DML_START.has(ast.type) ? 'dml' : 'utility';
      if (opts.query && kind !== 'query') throw synErr('syntax error at or near "' + toks[start].v + '"', pos);
      return { k: 'sql', kind, ast, text, into, perform: !!opts.perform, scope: sc, pos };
    }

    // ---- control structures ----
    ifStmt(sc) {
      this.kw('if');
      const conds = [];
      let cond = this.expr(sc, ['then']);
      this.kw('then');
      let body = this.stmts(sc, ['elsif', 'elseif', 'else', 'end']);
      conds.push({ cond, body });
      let els = null;
      for (;;) {
        if (this.eat('elsif') || this.eat('elseif')) { cond = this.expr(sc, ['then']); this.kw('then'); body = this.stmts(sc, ['elsif', 'elseif', 'else', 'end']); conds.push({ cond, body }); continue; }
        if (this.eat('else')) { els = this.stmts(sc, ['end']); }
        break;
      }
      this.kw('end', 'if');
      this.semi();
      return { k: 'if', conds, els };
    }
    caseStmt(sc) {
      this.kw('case');
      let base = null, slot = -1;
      const csc = newScope(sc, null);
      if (!this.is('when')) {
        base = this.expr(sc, ['when']);
        slot = this.addSlot(csc, '__case_' + this.caseN++, { kind: 'auto', spec: { auto: true } });
      }
      const whens = [];
      while (this.eat('when')) {
        let cond;
        if (base) {
          const start = this.t.pos;
          this.expr(csc, ['then']);
          const text = this.src.slice(start, this.t.pos);
          cond = this.mkExpr(csc, '"' + this.slots[slot].name + '" in (' + text + ')', start);
        } else cond = this.expr(sc, ['then']);
        this.kw('then');
        whens.push({ cond, body: this.stmts(sc, ['when', 'else', 'end']) });
      }
      let els = null;
      if (this.eat('else')) els = this.stmts(sc, ['end']);
      this.kw('end', 'case');
      this.semi();
      return { k: 'case', base, slot, whens, els };
    }
    loopBody(sc, label, close) {
      this.loops.push({ label, loop: true });
      const body = this.stmts(sc, [close === 'until' ? 'until' : 'end']);
      this.loops.pop();
      return body;
    }
    endLoop(label, what) {
      if (this.iso && what !== 'loop') this.kw('end', what); else this.kw('end', 'loop');
      this.endLabel(label);
      this.semi();
    }
    loopStmt(sc, label) { this.kw('loop'); const body = this.loopBody(sc, label); this.endLoop(label, 'loop'); return { k: 'loop', label, body }; }
    whileStmt(sc, label) {
      this.kw('while');
      const cond = this.expr(sc, this.iso ? ['do', 'loop'] : ['loop']);
      const iso = this.eat('do');
      if (!iso) this.kw('loop');
      const body = this.loopBody(sc, label);
      this.endLoop(label, iso ? 'while' : 'loop');
      return { k: 'while', label, cond, body };
    }
    repeatStmt(sc, label) {
      this.kw('repeat');
      const body = this.loopBody(sc, label, 'until');
      this.kw('until');
      const cond = this.expr(sc, ['end']);
      this.kw('end', 'repeat');
      this.endLabel(label);
      this.semi();
      return { k: 'repeat', label, cond, body };
    }
    /** is there a '..' at depth zero before LOOP? (then FOR is an integer loop) */
    dotsAhead() {
      let d = 0;
      for (let k = this.p.i; k < this.p.toks.length; k++) {
        const t = this.p.toks[k];
        if (t.t === 'eof') return false;
        if (t.t === 'op' && (t.v === '(' || t.v === '[')) d++;
        else if (t.t === 'op' && (t.v === ')' || t.v === ']')) d--;
        else if (d === 0 && t.t === 'op' && t.v === '..') return true;
        else if (d === 0 && t.t === 'id' && (t.v === 'loop' || t.v === 'select' || t.v === 'execute')) return false;
        else if (d === 0 && t.t === 'op' && t.v === ';') return false;
      }
      return false;
    }
    forStmt(sc, label) {
      this.kw('for');
      if (this.iso && this.t.t === 'id' && this.is('as', 1)) {
        // FOR v AS [c CURSOR FOR] query DO ... END FOR
        const name = this.declName();
        this.kw('as');
        if (this.t.t === 'id' && this.is('cursor', 1)) { this.p.i += 2; this.kw('for'); }
        const fsc = newScope(sc, null);
        const slot = this.addSlot(fsc, name, { kind: 'record', spec: { record: true } });
        const q = this.sql(fsc, { until: ['do'], noInto: true, query: true });
        this.kw('do');
        const body = this.loopBody(fsc, label);
        this.endLoop(label, 'for');
        return { k: 'forq', label, targets: [{ slot, path: [] }], query: q, body, isoAs: true };
      }
      const nameTok = this.t;
      if (nameTok.t !== 'id') this.fail('syntax error at or near ' + this.near());
      // integer loop: the variable is declared by the loop, in a scope of its own
      if (this.is('in', 1) && (this.is('reverse', 2) || (this.p.i += 2, this.dotsAhead() ? (this.p.i -= 2, true) : (this.p.i -= 2, false)))) {
        this.p.i += 2;
        const reverse = this.eat('reverse');
        const fsc = newScope(sc, null);
        const slot = this.addSlot(fsc, nameTok.v, { spec: { type: B().int4 } });
        const lo = this.expr(sc, ['..']);
        this.op('..');
        const hi = this.expr(sc, ['by', 'loop']);
        let by = null;
        if (this.eat('by')) by = this.expr(sc, ['loop']);
        this.kw('loop');
        const body = this.loopBody(fsc, label);
        this.endLoop(label, 'loop');
        return { k: 'fori', label, slot, lo, hi, by, reverse, body };
      }
      // FOR rec IN bound_cursor: the record is declared by the loop
      if (this.is('in', 1) && this.p.peek(2).t === 'id' && (this.is('loop', 3) || this.isOp('(', 3))) {
        const ci = lookupVar(sc, this.p.peek(2).v);
        if (ci >= 0 && this.slots[ci].cursor) {
          this.p.i += 3;
          const fsc = newScope(sc, null);
          const slot = this.addSlot(fsc, nameTok.v, { kind: 'record', spec: { record: true } });
          const args = this.cursorArgs(sc, ci);
          this.kw('loop');
          const body = this.loopBody(fsc, label);
          this.endLoop(label, 'loop');
          return { k: 'forq', label, targets: [{ slot, path: [] }], cursor: ci, args, body };
        }
      }
      const targets = this.targets(sc);
      this.kw('in');
      let s;
      if (this.eat('execute')) {
        const e = this.expr(sc, ['using', 'loop']);
        const using = [];
        if (this.eat('using')) do using.push(this.expr(sc, [',', 'loop'])); while (this.eatOp(','));
        s = { k: 'forq', label, targets, dyn: { expr: e, using } };
      } else if (this.t.t === 'id' && lookupVar(sc, this.t.v) >= 0 && this.slots[lookupVar(sc, this.t.v)].cursor && (this.is('loop', 1) || this.isOp('(', 1))) {
        const cur = lookupVar(sc, this.t.v);
        this.p.i++;
        const args = this.cursorArgs(sc, cur);
        s = { k: 'forq', label, targets, cursor: cur, args };
      } else s = { k: 'forq', label, targets, query: this.sql(sc, { until: ['loop'], noInto: true, query: true }) };
      this.kw('loop');
      s.body = this.loopBody(sc, label);
      this.endLoop(label, 'loop');
      return s;
    }
    foreachStmt(sc, label) {
      this.kw('foreach');
      const targets = this.targets(sc);
      let slice = 0;
      if (this.eat('slice')) { const t = this.t; if (t.t !== 'int') this.fail(); slice = +t.v; this.p.i++; }
      this.kw('in', 'array');
      const arr = this.expr(sc, ['loop']);
      this.kw('loop');
      const body = this.loopBody(sc, label);
      this.endLoop(label, 'loop');
      return { k: 'foreach', label, targets, slice, arr, body };
    }
    exitStmt(cont, sc) {
      const t0 = this.t;
      this.p.i++;
      let label = null;
      if (this.t.t === 'id' && !this.is('when') && (!K.RESERVED.has(this.t.v) || this.loops.some((x) => x.label === this.t.v))) label = this.p.label();
      let cond = null;
      if (this.eat('when')) cond = this.expr(sc, [';']);
      this.semi();
      const what = cont ? 'CONTINUE' : 'EXIT';
      if (label) {
        const l = [...this.loops].reverse().find((x) => x.label === label);
        if (!l) throw synErr('there is no label "' + label + '" attached to any block or loop enclosing this statement', t0.pos);
        if (cont && !l.loop) throw synErr('block label "' + label + '" cannot be used in CONTINUE', t0.pos);
      } else if (!this.loops.some((x) => x.loop)) throw synErr(cont ? 'CONTINUE cannot be used outside a loop' : 'EXIT cannot be used outside a loop, unless it has a label', t0.pos);
      return { k: 'exit', cont, label, cond };
    }
    returnStmt(sc) {
      const t0 = this.t;
      this.kw('return');
      const f = this.f;
      const setof = f.setof || f.returnsTable;
      const outs = f.params.some((p) => p.mode === 'out' || p.mode === 'inout') || f.returnsTable;
      if (this.eat('next')) {
        if (!setof) throw K.err(S.datatypeMismatch, 'cannot use RETURN NEXT in a non-SETOF function', { pos: t0.pos });
        let e = null;
        if (!this.isOp(';')) { if (outs) throw K.err(S.datatypeMismatch, 'RETURN NEXT cannot have a parameter in function with OUT parameters', { pos: this.t.pos }); e = this.expr(sc, [';']); }
        else if (!outs) throw synErr('RETURN NEXT must have a parameter', t0.pos);
        this.semi();
        return { k: 'returnNext', expr: e };
      }
      if (this.eat('query')) {
        if (!setof) throw K.err(S.datatypeMismatch, 'cannot use RETURN QUERY in a non-SETOF function', { pos: t0.pos });
        if (this.eat('execute')) {
          const e = this.expr(sc, ['using', ';']);
          const using = [];
          if (this.eat('using')) do using.push(this.expr(sc, [',', ';'])); while (this.eatOp(','));
          this.semi();
          return { k: 'returnQuery', dyn: { expr: e, using } };
        }
        const q = this.sql(sc, { until: [';'], noInto: true, query: true });
        this.semi();
        return { k: 'returnQuery', query: q };
      }
      if (this.isOp(';') || (this.iso && this.isEndish())) {
        if (!setof && !outs && f.kind === 'function' && !this.trigger && !(f.retType && f.retType.id === 'void')) throw synErr('missing expression at or near ";"', this.t.pos);
        if (this.trigger) throw synErr('missing expression at or near ";"', this.t.pos);
        this.semi();
        return { k: 'return', expr: null };
      }
      if (f.kind === 'procedure') throw synErr('RETURN cannot have a parameter in a procedure', this.t.pos);
      if (setof) throw K.err(S.datatypeMismatch, 'RETURN cannot have a parameter in function returning set', { pos: this.t.pos, hint: 'Use RETURN NEXT or RETURN QUERY.' });
      if (outs) throw K.err(S.datatypeMismatch, 'RETURN cannot have a parameter in function with OUT parameters', { pos: this.t.pos });
      if (f.retType && f.retType.id === 'void') throw K.err(S.datatypeMismatch, 'RETURN cannot have a parameter in function returning void', { pos: this.t.pos });
      const e = this.expr(sc, [';']);
      this.semi();
      return { k: 'return', expr: e };
    }
    raiseStmt(sc) {
      const t0 = this.t;
      this.kw('raise');
      if (this.isOp(';')) { this.p.i++; return { k: 'raise', reraise: true }; }
      let level = 'exception';
      const lv = this.word();
      if (lv && LEVELS.includes(lv)) { level = lv; this.p.i++; }
      const s = { k: 'raise', level, fmt: null, args: [], opts: [], cond: null, sqlstate: null };
      if (this.t.t === 'str') {
        s.fmt = this.t.v;
        this.p.i++;
        while (this.eatOp(',')) s.args.push(this.expr(sc, [',', ';', 'using']));
        const n = (s.fmt.replace(/%%/g, '').match(/%/g) || []).length;
        if (n > s.args.length) throw synErr('too few parameters specified for RAISE', t0.pos);
        if (n < s.args.length) throw synErr('too many parameters specified for RAISE', t0.pos);
      } else if (this.eat('sqlstate')) {
        const t = this.t; if (t.t !== 'str') this.fail(); this.p.i++;
        if (!/^[0-9A-Z]{5}$/.test(t.v)) throw synErr('invalid SQLSTATE code', t.pos);
        s.sqlstate = t.v;
      } else if (this.t.t === 'id' && !this.is('using')) {
        const t = this.t;
        const name = this.p.label();
        if (!CONDITIONS[name]) throw K.err(S.undefinedObject, 'unrecognized exception condition "' + name + '"', { pos: t.pos });
        s.cond = name;
      }
      if (this.eat('using')) {
        do {
          const t = this.t;
          const o = this.p.label();
          if (!['message', 'detail', 'hint', 'errcode', 'column', 'constraint', 'datatype', 'table', 'schema'].includes(o)) throw synErr('unrecognized RAISE statement option "' + o + '"', t.pos);
          if (!this.eatOp('=')) this.op(':=');
          if (o === 'message' && s.fmt !== null) throw synErr('RAISE option already specified: MESSAGE', t.pos);
          s.opts.push({ o, e: this.expr(sc, [',', ';']) });
        } while (this.eatOp(','));
      }
      this.semi();
      return s;
    }
    signalStmt(sc, re) {
      this.p.i++;
      const s = { k: 'raise', level: 'exception', fmt: null, args: [], opts: [], cond: null, sqlstate: null, reraise: re && this.isOp(';') };
      if (this.eat('sqlstate')) { this.eat('value'); const t = this.t; if (t.t !== 'str') this.fail(); this.p.i++; s.sqlstate = t.v; }
      else if (this.t.t === 'id' && !this.is('set')) { const n = this.p.name(); s.sqlstate = (this.condNames && this.condNames.get(n)) || CONDITIONS[n] || '45000'; s.condName = n; }
      if (this.eat('set')) {
        do {
          const o = this.p.label();
          this.op('=');
          s.opts.push({ o: o === 'message_text' ? 'message' : o, e: this.expr(sc, [',', ';']) });
        } while (this.eatOp(','));
      }
      this.semi();
      return s;
    }
    executeStmt(sc) {
      this.kw('execute');
      const e = this.expr(sc, ['into', 'using', ';']);
      let into = null;
      const using = [];
      for (;;) {
        if (this.eat('into')) { const strict = this.eat('strict'); into = { targets: this.targets(sc), strict }; continue; }
        if (this.eat('using')) { do using.push(this.expr(sc, [',', ';', 'into'])); while (this.eatOp(',')); continue; }
        break;
      }
      this.semi();
      return { k: 'execute', expr: e, into, using };
    }
    getDiag(sc) {
      this.kw('get');
      const stacked = this.eat('stacked');
      if (!stacked) this.eat('current');
      this.kw('diagnostics');
      const items = [];
      do {
        const tgt = this.target(sc);
        if (!this.eatOp('=')) this.op(':=');
        const t = this.t;
        const item = this.p.label();
        if (!(stacked ? STACKED : DIAG).includes(item)) throw synErr('unrecognized GET DIAGNOSTICS item at or near "' + item + '"', t.pos);
        items.push({ target: tgt, item });
      } while (this.eatOp(','));
      this.semi();
      return { k: 'getdiag', stacked, items };
    }
    cursorRef(sc) {
      const t = this.t;
      const n = this.p.name();
      const i = lookupVar(sc, n);
      if (i < 0) throw synErr('"' + n + '" is not a known variable', t.pos);
      return i;
    }
    cursorArgs(sc, cur) {
      const info = this.slots[cur].cursor;
      const args = [];
      if (this.eatOp('(')) {
        do {
          if (this.t.t === 'id' && (this.isOp(':=', 1) || this.isOp('=>', 1))) {
            const n = this.t.v; this.p.i += 2;
            const k = info.args.findIndex((a) => this.slots[a].name === n);
            if (k < 0) throw synErr('cursor "' + this.slots[cur].name + '" has no argument named "' + n + '"', this.t.pos);
            args[k] = this.expr(sc, [',', ')']);
          } else args.push(this.expr(sc, [',', ')']));
        } while (this.eatOp(','));
        this.op(')');
      }
      if (args.length !== info.args.length) throw synErr(args.length < info.args.length ? 'not enough arguments for cursor "' + this.slots[cur].name + '"' : 'too many arguments for cursor "' + this.slots[cur].name + '"', this.t.pos);
      return args;
    }
    openStmt(sc) {
      this.kw('open');
      const cur = this.cursorRef(sc);
      const info = this.slots[cur];
      if (info.cursor) { const args = this.cursorArgs(sc, cur); this.semi(); return { k: 'open', cur, bound: true, args }; }
      let scroll;
      if (this.eat('no', 'scroll')) scroll = false; else if (this.eat('scroll')) scroll = true;
      this.kw('for');
      if (this.eat('execute')) {
        const e = this.expr(sc, ['using', ';']);
        const using = [];
        if (this.eat('using')) do using.push(this.expr(sc, [',', ';'])); while (this.eatOp(','));
        this.semi();
        return { k: 'open', cur, scroll, dyn: { expr: e, using } };
      }
      const q = this.sql(sc, { until: [';'], noInto: true, query: true });
      this.semi();
      return { k: 'open', cur, scroll, query: q };
    }
    fetchStmt(sc, move) {
      this.p.i++;
      let dir = 'next', count = null;
      const w = this.word();
      const isDir = w && ['next', 'prior', 'first', 'last', 'absolute', 'relative', 'forward', 'backward'].includes(w) && !(lookupVar(sc, w) >= 0 && (this.is('into', 1) || this.isOp(';', 1)));
      if (isDir) {
        this.p.i++;
        dir = w;
        if (w === 'absolute' || w === 'relative') count = this.expr(sc, ['from', 'in']);
        else if ((w === 'forward' || w === 'backward') && !this.is('from') && !this.is('in')) {
          if (this.eat('all')) count = 'all'; else if (!(this.t.t === 'id' && (this.is('into', 1) || this.isOp(';', 1)))) count = this.expr(sc, ['from', 'in']);
        }
      }
      this.eat('from') || this.eat('in');
      const cur = this.cursorRef(sc);
      let into = null;
      if (!move) { this.kw('into'); into = { targets: this.targets(sc) }; }
      this.semi();
      return { k: 'fetch', move, dir, count, cur, into };
    }
  }
  /** $1, $2 ... in a body are the function's parameters: they are resolved like names */
  function paramsToNames(ast) {
    const walk = (x) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) { const y = x[i]; if (y && y.k === 'param') x[i] = { k: 'col', parts: ['$' + y.n], pos: y.pos }; else walk(y); } return; }
      for (const k of Object.keys(x)) { const y = x[k]; if (y && typeof y === 'object') { if (y.k === 'param' && k !== 'type') x[k] = { k: 'col', parts: ['$' + y.n], pos: y.pos }; else walk(y); } }
    };
    walk(ast);
  }

  /** is a BEGIN ATOMIC body procedural (SQL/PSM statements) rather than a list of plain SQL statements? */
  function isProcedural(body) {
    let toks;
    try { toks = K.lex(body); } catch (e) { return false; }
    let atStart = true, depth = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t === 'op' && t.v === '(') depth++;
      if (t.t === 'op' && t.v === ')') depth--;
      if (t.t === 'op' && t.v === ';') { atStart = true; continue; }
      if (atStart && t.t === 'id' && !t.quoted) {
        if (['declare', 'set', 'if', 'while', 'repeat', 'for', 'loop', 'leave', 'iterate', 'signal', 'resignal', 'case', 'begin', 'open', 'fetch', 'close', 'return'].includes(t.v)) return true;
        if (toks[i + 1] && toks[i + 1].t === 'op' && toks[i + 1].v === ':') return true;
      }
      if (depth === 0 && t.t === 'id' && t.v === 'into' && !(toks[i - 1] && ['insert', 'merge'].includes(toks[i - 1].v))) return true;
      atStart = false;
    }
    return false;
  }

  /** parse a routine's body (at CREATE time, so syntax errors are reported then) */
  function compile(f, session) {
    const iso = f.lang === 'psm' || (f.lang === 'sql' && f.atomic);
    let comp;
    try { comp = new PLParser(f, iso).parse(); } catch (e) { if (e.pos !== undefined && f.bodyPos !== undefined) e.pos += f.bodyPos; throw e; }
    comp.plpgsql = true;
    comp.name = f.name;
    comp.bodyPos = f.bodyPos;
    if (session) resolveTypes(comp, session, true);
    return comp;
  }

  // ---- types of the variables -------------------------------------------------------------------------------------
  function resolveTypes(comp, s, validate) {
    const cat = s.catalog;
    if (comp.types && comp.types.cat === cat && comp.types.ver === cat.version) return comp.types.list;
    const list = [];
    for (const info of comp.slots) {
      const sp = info.spec || {};
      let t = null;
      try {
        if (sp.type) t = sp.type;
        else if (sp.record || sp.auto) t = null;
        else if (sp.ast) t = s.db.ddl.typeOf(sp.ast, cat, s, sp.pos);
        else if (sp.copyOf) t = copyType(comp, list, sp, cat, s);
        else if (sp.rowOf) t = rowOfType(sp, cat, s);
      } catch (e) { if (validate && e.pos !== undefined && comp.bodyPos !== undefined) e.pos += comp.bodyPos; throw e; }
      list.push(t);
      if (t && isComposite(t) && info.kind === 'scalar') info.kind = 'row';
    }
    comp.types = { cat, ver: cat.version, list };
    return list;
  }
  function copyType(comp, list, sp, cat, s) {
    const parts = sp.copyOf;
    // a variable declared earlier
    for (let i = list.length - 1; i >= 0; i--) if (comp.slots[i].name === parts[0]) {
      let t = list[i];
      for (const f of parts.slice(1)) { const x = t && t.fields && t.fields.find((y) => y.name === f); if (!x) throw K.err(S.undefinedColumn, 'column "' + f + '" does not exist', { pos: sp.pos }); t = x.type; }
      if (t) return t;
    }
    if (parts.length < 2) throw K.err(S.undefinedObject, 'variable "' + parts[0] + '" does not exist', { pos: sp.pos });
    const qn = parts.length === 3 ? { schema: parts[0], name: parts[1] } : { name: parts[0] };
    const rel = cat.lookup(qn, s.searchPath(), ['table', 'view', 'matview']);
    if (!rel) throw K.err(S.undefinedTable, 'relation "' + qn.name + '" does not exist', { pos: sp.pos });
    const c = rel.cols.find((x) => x.name === parts[parts.length - 1] && !x.dropped);
    if (!c) throw K.err(S.undefinedColumn, 'column "' + parts[parts.length - 1] + '" of relation "' + rel.name + '" does not exist', { pos: sp.pos });
    return c.type;
  }
  function rowOfType(sp, cat, s) {
    const parts = sp.rowOf;
    const qn = parts.length === 2 ? { schema: parts[0], name: parts[1] } : { name: parts[0] };
    const rel = cat.lookup(qn, s.searchPath(), ['table', 'view', 'matview']);
    if (rel) return cat.rowType(rel);
    const t = T().byName(parts.join('.'), null, cat);
    if (t && isComposite(t)) return t;
    throw K.err(S.undefinedTable, 'relation "' + parts.join('.') + '" does not exist', { pos: sp.pos });
  }

  // ---- values ------------------------------------------------------------------------------------------------------
  /** a value stored in a variable: PL/pgSQL uses the assignment cast, and falls back to text input/output */
  function coerceTo(v, from, to, ctx) {
    if (v === null || v === undefined) return null;
    if (!to || (to.cat === 'P' && to.id !== 'unknown') || (to.id === 'record' && !to.fields)) return v;
    if (!from && to.cat === 'A' && v instanceof K.ArrayV) return v;
    if (isComposite(to)) {
      if (v instanceof K.RowV) {
        if (v.type === to) return v;
        const vals = v.values;
        if (vals.length !== to.fields.length) throw K.err(S.datatypeMismatch, 'returned record type does not match expected record type', { detail: 'Number of returned columns (' + vals.length + ') does not match expected column count (' + to.fields.length + ').' });
        const fts = v.type && v.type.fields;
        return new K.RowV(vals.map((x, i) => coerceTo(x, fts && fts[i] ? fts[i].type : null, to.fields[i].type, ctx)), to);
      }
      if (typeof v === 'string') return T().input(v, to, ctx);
      throw K.err(S.datatypeMismatch, 'cannot assign non-composite value to a row variable');
    }
    if (from && from.id === to.id && !to.domain && to.cat !== 'S' && to.cat !== 'A' && to.cat !== 'C' && !(to.id === 'numeric' && to.p !== undefined) && to.prec === undefined) return v;
    const ft = from && from.cat !== 'P' ? (from.domain ? from.base : from) : T().typeOfValue(v);
    const tt = to.domain ? to.base : to;
    // an assignment cast where one exists (within a category, implicit casts, anything to a string type), else text I/O
    const viaIO = () => T().input(T().output(v, ft, ctx), to, ctx);
    if (!(ft.cat === tt.cat && ft.cat !== 'B') && !T().implicit(ft, tt) && tt.cat !== 'S' && typeof v !== 'string') return viaIO();
    try { return T().cast(v, from || null, to, false, ctx); }
    catch (e) {
      if (e.code !== S.datatypeMismatch && e.code !== S.featureNotSupported) throw e;
      return viaIO();
    }
  }
  const asBool = (v, t, ctx) => (v === null || typeof v === 'boolean' ? v : coerceTo(v, t, B().bool, ctx));
  function toInt(v, t, ctx) { if (v === null) return null; const x = coerceTo(v, t, B().int4, ctx); return Number(x); }

  // ---- the running frame ---------------------------------------------------------------------------------------
  const VARDEF = [];
  /** a variable read: a call with no arguments (so the planner treats it as a constant, e.g. for index scans) */
  function varDef(i) {
    if (!VARDEF[i]) VARDEF[i] = { name: 'plvar', strict: false, volatile: false, fn: (vals, ctx) => { const fr = ctx.plFrame; return fr ? fr.slots[i].value : null; } };
    return VARDEF[i];
  }

  class Frame {
    constructor(f, comp, s, ctx) {
      this.f = f;
      this.c = comp;
      this.s = s;
      const types = resolveTypes(comp, s, false);
      this.slots = comp.slots.map((info, i) => ({ value: null, type: types[i], info, tkey: null }));
      const c = Object.assign({}, ctx, { plFrame: this, cteCache: new Map(), subCache: new Map(), outer: null });
      c.subplan = (n, r, l) => s.subplan(c, n, r, l);
      c.callUdf = (n, a) => s.callUdf(c, n, a);
      c.callUdfSet = (n, a) => s.callUdf(c, n, a, true);
      this.ctx = c;
      this.out = null;
      this.retVal = undefined;
      this.rowCount = 0;
      this.errs = [];
      this.steps = 0;
      this._sig = null;
      this.workTables = null;
      this.ctes = null;
      this.isoHandlers = [];
    }
    get tx() { return this.ctx.tx; }
    /** a key for the types of the variables whose type is only known at run time (records): plans depend on them */
    sig() {
      if (this._sig === null) { let k = this.sigExtra || ''; for (const sl of this.slots) if (sl.info.kind === 'record' || sl.info.kind === 'auto') k += (sl.tkey || '-') + ';'; this._sig = k; }
      return this._sig;
    }
    found(v) { this.slots[this.c.found].value = v; }
    setType(sl, t) { const k = tkey(t); if (k !== sl.tkey) { sl.tkey = k; this._sig = null; } sl.type = t; }
    where(st) { return 'PL/pgSQL function ' + this.f.name + '(' + this.f.params.filter((p) => p.mode !== 'out').map((p) => T().sqlName(p.type)).join(',') + ') line ' + (st ? st.line : '?') + ' at ' + stmtName(st); }
  }
  function stmtName(st) {
    if (!st) return 'statement';
    switch (st.k) {
      case 'sql': return st.perform ? 'PERFORM' : st.kind === 'call' ? 'CALL' : 'SQL statement';
      case 'assign': return 'assignment';
      case 'returnNext': return 'RETURN NEXT';
      case 'returnQuery': return 'RETURN QUERY';
      case 'fori': return 'FOR with integer loop variable';
      case 'forq': return 'FOR over SELECT rows';
      case 'getdiag': return 'GET DIAGNOSTICS';
      default: return st.k.toUpperCase();
    }
  }

  // ---- command ids and subtransactions ----------------------------------------------------------------------------
  // The session reads tx.cid live, so a statement inside a function gets a command id above every one used so far
  // and the caller's id is put back afterwards: the caller does not see the function's changes (as its snapshot
  // would not in PostgreSQL), and the session's next statement starts above them.
  function cidGuard(tx) {
    if (tx.__pl) return tx.__pl;
    let val = tx.cid;
    const g = { high: val, get: () => val, set: (v) => { val = v; } };
    Object.defineProperty(tx, 'cid', { get: () => val, set: (v) => { val = v > val ? Math.max(v, g.high + 1) : v; }, configurable: true, enumerable: true });
    Object.defineProperty(tx, '__pl', { value: g, enumerable: false, configurable: true, writable: true });
    return g;
  }
  function withCid(fr, fn) {
    const g = cidGuard(fr.ctx.tx);
    const saved = g.get();
    const mine = Math.max(saved, g.high) + 1;
    g.high = mine;
    g.set(mine);
    try { return fn(); } finally { g.set(saved); }
  }
  function* withCidG(fr, gen) {
    const g = cidGuard(fr.ctx.tx);
    const saved = g.get();
    const mine = Math.max(saved, g.high) + 1;
    g.high = mine;
    g.set(mine);
    try { return yield* gen; } finally { g.set(saved); }
  }
  function subBegin(s, tx) {
    const sp = { name: null, internal: true, xid: 0, catalog: tx.catalog ? tx.catalog.clone() : null, hadCatalog: !!tx.catalog, cid: tx.cid, deferred: (tx.deferred || []).length };
    tx.savepoints.push(sp);
    s.db.bus.emit('xact.subbegin', { tx: tx.id });
    return sp;
  }
  function subEnd(s, tx, sp, ok) {
    const i = tx.savepoints.indexOf(sp);
    if (i < 0) return;
    if (!ok) {
      for (let k = i; k < tx.savepoints.length; k++) if (tx.savepoints[k].xid) s.db.xact.setStatus(tx.savepoints[k].xid, K.XSTATUS.ABORTED);
      if (sp.xid) s.db.wal.log({ xid: sp.xid, type: 'abort', sub: true });
      if (sp.hadCatalog) tx.catalog = sp.catalog; else tx.catalog = null;
      if (tx.deferred) tx.deferred.length = Math.min(tx.deferred.length, sp.deferred);
    }
    tx.savepoints.length = i;
    s.db.bus.emit(ok ? 'xact.subcommit' : 'xact.subabort', { tx: tx.id, xid: sp.xid });
  }
  // a statement's own context: fresh caches, its snapshot (per statement under READ COMMITTED), its planner
  function stmtCtx(fr, planner, params) {
    const b = fr.ctx;
    const tx = b.tx;
    const c = Object.assign({}, b, { cteCache: new Map(), subCache: new Map(), afterQueue: [], rowCount: 0, planner: planner || null, plTrig: null, workTables: fr.workTables || new Map() });
    if (params) c.params = params;
    c.snap = tx.isolation === 'read committed' ? fr.s.db.xact.snapshot(tx.xid || null) : (tx.snapshot || (tx.snapshot = fr.s.db.xact.snapshot(tx.xid || null)));
    c.subplan = (n, r, l) => fr.s.subplan(c, n, r, l);
    c.callUdf = (n, a) => fr.s.callUdf(c, n, a);
    c.callUdfSet = (n, a) => fr.s.callUdf(c, n, a, true);
    return c;
  }

  // ---- binding and planning ------------------------------------------------------------------------------------------
  function binderFor(fr, scope) {
    const b = new K.Binder(fr.s);
    b.pl = { scope, fr };
    return b;
  }
  /** the scope above a statement: transition tables of a trigger appear as tables */
  function topScope(fr) {
    if (!fr.ctes) return null;
    const sc = new K.Scope(null);
    for (const [name, cte] of fr.ctes) sc.ctes.set(name, cte);
    return sc;
  }
  function cacheOk(c, fr) { const cat = fr.s.catalog; return c && c.cat === cat && c.ver === cat.version && c.sig === fr.sig() && c.sess === fr.s; }
  function stamp(c, fr) { const cat = fr.s.catalog; c.cat = cat; c.ver = cat.version; c.sig = fr.sig(); c.sess = fr.s; return c; }
  const simpleSelect = (q) => q.type === 'select' && !q.from.length && !q.where && !q.groupBy && !q.having && !q.order && q.limit === undefined && q.offset === undefined && !q.distinct && !q.with && !q.windows && !q.into && !q.locking && q.targets.length === 1 && !q.targets[0].star;
  function prepExpr(e, fr) {
    if (cacheOk(e.cache, fr)) return e.cache;
    const q = e.ast;
    let c = null;
    if (simpleSelect(q)) {
      const b = binderFor(fr, e.scope);
      try {
        const be = b.expr(q.targets[0].expr, topScope(fr) || new K.Scope(null), {});
        let hasSub = false;
        b.walk(be, (x) => { if (x.k === 'sub') hasSub = true; }, true);
        c = { simple: true, fn: K.Expr.compile(be, new Map()), type: be.type, hasSub, planner: new K.Planner(fr.s, b) };
      } catch (err) { if (err.code !== S.groupingError && err.code !== S.featureNotSupported && err.code !== S.windowingError) throw err; c = null; }
    }
    if (!c) c = planQuery(q, e.scope, fr);
    e.cache = stamp(c, fr);
    return c;
  }
  function planQuery(q, scope, fr) {
    const b = binderFor(fr, scope);
    const logical = b.query(q, topScope(fr));
    const planner = new K.Planner(fr.s, b);
    const plan = planner.plan(logical);
    const cols = plan.cols.filter((x) => !x.hidden);
    return { plan, planner, cols, type: cols.length ? cols[0].type : B().unknown, rec: recType(cols) };
  }
  function prepSql(st, fr) {
    if (cacheOk(st.cache, fr)) return st.cache;
    return (st.cache = stamp(planQuery(st.ast, st.scope, fr), fr));
  }
  /**
   * run a plan; returns its rows (a query may stop early after limit rows). A statement that must wait for a lock
   * passes the wait up, so procedures and triggers run side by side with other sessions; inside an expression
   * (which cannot pause) a wait is an error.
   */
  function* runPlanG(c, fr, limit, params) {
    return yield* withCidG(fr, (function* () {
      const ctx = stmtCtx(fr, c.planner, params);
      const rows = [];
      const width = c.cols.length;
      const isModify = c.plan.op === 'Modify';
      for (const r of K.Exec.run(c.plan, ctx)) {
        if (K.Exec.isSignal(r)) { fr.s.waiting = r; yield r; fr.s.waiting = null; continue; }
        rows.push(r.length > width ? r.slice(0, width) : r);
        if (limit && !isModify && rows.length >= limit) break;
      }
      yield* fr.s.db.dml.runAfter(ctx);
      if (isModify) yield* fr.s.checkAssertions(ctx, c.plan);
      fr.lastCount = isModify ? (c.plan.count !== undefined ? c.plan.count : ctx.rowCount) : rows.length;
      return rows;
    })());
  }
  const runPlan = (c, fr, limit, params) => drainValue(runPlanG(c, fr, limit, params));

  // ---- evaluating ----------------------------------------------------------------------------------------------------
  /** the value of an expression; its type is left in fr.lt */
  function evalE(e, fr) {
    const c = prepExpr(e, fr);
    if (c.simple) {
      fr.lt = c.type;
      if (!c.hasSub) return c.fn(EMPTY, fr.ctx);
      return withCid(fr, () => c.fn(EMPTY, stmtCtx(fr, c.planner)));
    }
    const rows = runPlan(c, fr, 2);
    if (c.cols.length !== 1) throw K.err(S.syntax, 'query "' + e.text + '" returned ' + c.cols.length + ' columns');
    if (rows.length > 1) throw K.err(S.cardinality, 'query "' + e.text + '" returned more than one row');
    fr.lt = c.type;
    return rows.length ? rows[0][0] : null;
  }
  function evalBool(e, fr) { const v = evalE(e, fr); return asBool(v, fr.lt, fr.ctx) === true; }

  // ---- variables ----------------------------------------------------------------------------------------------------
  function initSlot(fr, i) {
    const sl = fr.slots[i];
    const info = sl.info;
    if (info.init !== undefined) { sl.value = info.init; return; }
    if (info.def) {
      const v = evalE(info.def, fr);
      setSlot(fr, i, v, fr.lt);
      return;
    }
    sl.value = info.kind === 'row' && sl.type && sl.type.fields ? new K.RowV(sl.type.fields.map(() => null), sl.type) : null;
    if (info.kind === 'record') { sl.type = null; sl.tkey = null; fr._sig = null; }
  }
  function setSlot(fr, i, v, vt) {
    const sl = fr.slots[i];
    const info = sl.info;
    if (info.kind === 'record' || info.kind === 'auto') {
      if (info.kind === 'record' && v !== null && !(v instanceof K.RowV)) throw K.err(S.datatypeMismatch, 'cannot assign non-composite value to a record variable');
      const t = v instanceof K.RowV ? (v.type && v.type.fields ? v.type : vt && vt.fields ? vt : v.type) : vt;
      if (t && (t.fields || info.kind === 'auto')) fr.setType(sl, t);
      sl.value = v;
      return;
    }
    const x = coerceTo(v, vt, sl.type, fr.ctx);
    if (x === null && info.notNull) throw K.err('22004', 'null value cannot be assigned to variable "' + info.name + '" declared NOT NULL');
    sl.value = x;
  }
  function assign(fr, tgt, v, vt) {
    if (!tgt.path.length) return setSlot(fr, tgt.slot, v, vt);
    const sl = fr.slots[tgt.slot];
    const name = sl.info.name;
    const put = (cur, ct, path) => {
      const p = path[0];
      if (p.field !== undefined) {
        if (!ct || !ct.fields) {
          if (sl.info.kind === 'record') throw K.err('55000', 'record "' + name + '" is not assigned yet', { detail: 'The tuple structure of a not-yet-assigned record is indeterminate.' });
          throw K.err(S.datatypeMismatch, 'cannot assign to field "' + p.field + '" of a value that is not a record');
        }
        const k = ct.fields.findIndex((f) => f.name === p.field);
        if (k < 0) throw K.err(S.undefinedColumn, 'record "' + name + '" has no field "' + p.field + '"');
        const vals = cur instanceof K.RowV ? cur.values.slice() : ct.fields.map(() => null);
        vals[k] = path.length > 1 ? put(vals[k], ct.fields[k].type, path.slice(1)) : coerceTo(v, vt, ct.fields[k].type, fr.ctx);
        return new K.RowV(vals, ct);
      }
      const idx = evalE(p.idx, fr);
      if (idx === null) throw K.err(S.nullNotAllowed, 'array subscript in assignment must not be null');
      const n = toInt(idx, fr.lt, fr.ctx);
      if (ct && ct.cat !== 'A') throw K.err(S.datatypeMismatch, 'subscripted object is not an array');
      const a = cur instanceof K.ArrayV ? cur : new K.ArrayV([], n);
      const items = a.items.slice();
      let lower = a.items.length ? a.lower : n;
      if (n < lower) { for (let k = n; k < lower; k++) items.unshift(null); lower = n; }
      while (items.length <= n - lower) items.push(null);
      items[n - lower] = path.length > 1 ? put(items[n - lower], ct && ct.elem, path.slice(1)) : coerceTo(v, vt, ct && ct.elem, fr.ctx);
      return new K.ArrayV(items, lower);
    };
    sl.value = put(sl.value, sl.type, tgt.path);
  }
  /** a row of a query into INTO targets: one record or row variable takes the whole row, else column by column */
  function assignRow(fr, targets, row, cols, rec) {
    const t0 = targets[0];
    const sl0 = fr.slots[t0.slot];
    if (targets.length === 1 && !t0.path.length && (sl0.info.kind === 'record' || sl0.info.kind === 'row')) {
      if (sl0.info.kind === 'record') {
        fr.setType(sl0, rec);
        sl0.value = row ? new K.RowV(row.slice(0, cols.length), rec) : null;
        return;
      }
      const rt = sl0.type;
      if (row && cols.length === 1 && cols[0].type && isComposite(cols[0].type) && row[0] instanceof K.RowV) { sl0.value = coerceTo(row[0], cols[0].type, rt, fr.ctx); return; }
      sl0.value = new K.RowV(rt.fields.map((f, i) => (row && i < cols.length ? coerceTo(row[i], cols[i].type, f.type, fr.ctx) : null)), rt);
      return;
    }
    targets.forEach((t, i) => assign(fr, t, row && i < cols.length ? row[i] : null, i < cols.length ? cols[i].type : null));
  }

  // ---- control flow -------------------------------------------------------------------------------------------------
  const RET = { ret: true };
  /** what a loop does with a signal from its body: 1 leave the loop, 2 next iteration, else pass it up */
  function tick(fr) { if (++fr.steps > MAX_STEPS) throw K.err(S.queryCanceled, 'canceling statement: function ' + fr.f.name + ' ran more than ' + MAX_STEPS + ' steps', { hint: 'Look for a loop that never ends.' }); }
  function loopCtl(r, s) {
    if (r === RET) return r;
    if (r.exit !== undefined) return r.exit === null || r.exit === s.label ? 1 : r;
    if (r.cont !== undefined) return r.cont === null || r.cont === s.label ? 2 : r;
    return r;
  }
  function* execList(list, fr) {
    for (let k = 0; k < list.length; k++) {
      const st = list[k];
      let r;
      if (fr.isoHandlers.length) {
        try { r = yield* execStmt(st, fr); }
        catch (e) {
          const h = isoHandler(fr, e, 'continue');
          if (!h) throw e;
          r = yield* runIsoHandler(fr, h, e);
        }
      } else r = yield* execStmt(st, fr);
      if (r) return r;
    }
    return null;
  }
  function* execStmt(st, fr) {
    tick(fr);
    fr.curStmt = st;
    try { return yield* execOne(st, fr); }
    catch (e) {
      if (e && e.code && !e.plContext) { e.plContext = fr.where(st); if (e.pos !== undefined) { e.internalPos = e.pos; delete e.pos; } if (st.text) e.internalQuery = st.text; }
      if (e && e.code && e.plStack === undefined) Object.defineProperty(e, 'plStack', { value: [], enumerable: false, writable: true });
      if (e && e.code && e.plStack && !e.plStack.includes(fr)) { e.plStack.push(fr); e.context = (e.context ? e.context + '\n' : '') + fr.where(st); }
      throw e;
    }
  }
  function* execOne(st, fr) {
    const bus = fr.s.db.bus;
    if (bus.active) bus.emit('psm.step', { fn: fr.f.name, line: st.line, kind: st.k });
    switch (st.k) {
      case 'block': { const r = yield* execBlock(st, fr); return r && r !== RET && st.label && r.exit === st.label ? null : r; }
      case 'assign': { const v = evalE(st.expr, fr); assign(fr, st.target, v, fr.lt); return null; }
      case 'if': {
        for (const c of st.conds) if (evalBool(c.cond, fr)) return yield* execList(c.body, fr);
        return st.els ? yield* execList(st.els, fr) : null;
      }
      case 'case': {
        if (st.base) { const v = evalE(st.base, fr); setSlot(fr, st.slot, v, fr.lt); }
        for (const w of st.whens) if (evalBool(w.cond, fr)) return yield* execList(w.body, fr);
        if (st.els) return yield* execList(st.els, fr);
        throw K.err('20000', 'case not found', { hint: 'CASE statement is missing ELSE part.' });
      }
      case 'loop':
        for (;;) { tick(fr); const r = yield* execList(st.body, fr); if (r) { const x = loopCtl(r, st); if (x === 1) break; if (x === 2) continue; return x; } }
        return null;
      case 'while':
        while (evalBool(st.cond, fr)) { tick(fr); const r = yield* execList(st.body, fr); if (r) { const x = loopCtl(r, st); if (x === 1) break; if (x === 2) continue; return x; } }
        return null;
      case 'repeat':
        for (;;) {
          tick(fr); const r = yield* execList(st.body, fr);
          if (r) { const x = loopCtl(r, st); if (x === 1) break; if (x !== 2) return x; }
          if (evalBool(st.cond, fr)) break;
        }
        return null;
      case 'fori': return yield* execForInt(st, fr);
      case 'forq': return yield* execForQuery(st, fr);
      case 'foreach': return yield* execForeach(st, fr);
      case 'exit':
        if (st.cond && !evalBool(st.cond, fr)) return null;
        return st.cont ? { cont: st.label } : { exit: st.label };
      case 'return': return execReturn(st, fr);
      case 'returnNext': execReturnNext(st, fr); return null;
      case 'returnQuery': yield* execReturnQuery(st, fr); return null;
      case 'raise': execRaise(st, fr); return null;
      case 'assert': {
        if (fr.s.settings['plpgsql.check_asserts'] === false) return null;
        const v = evalE(st.cond, fr);
        if (asBool(v, fr.lt, fr.ctx) !== true) {
          const m = st.msg ? evalE(st.msg, fr) : null;
          throw K.err('P0004', m === null ? 'assertion failed' : T().output(m, fr.lt, fr.ctx));
        }
        return null;
      }
      case 'sql': return yield* execSql(st, fr);
      case 'execute': yield* execDynamic(st, fr); return null;
      case 'getdiag': execGetDiag(st, fr); return null;
      case 'open': yield* execOpen(st, fr); return null;
      case 'fetch': execFetch(st, fr); return null;
      case 'close': {
        const name = fr.slots[st.cur].value;
        if (name === null) throw K.err('22004', 'cursor variable "' + fr.slots[st.cur].info.name + '" is null');
        if (!fr.s.cursors.has(name)) throw K.err(S.invalidCursor, 'cursor "' + name + '" does not exist');
        fr.s.cursors.delete(name);
        return null;
      }
      case 'null': return null;
      case 'commit': case 'rollback': yield* execTxEnd(st, fr); return null;
    }
    throw K.err(S.internal, 'unknown procedural statement ' + st.k);
  }
  function* execBlock(b, fr) {
    for (const i of b.decls) initSlot(fr, i);
    const saveIso = fr.isoHandlers.length;
    if (b.isoHandlers) for (const h of b.isoHandlers) fr.isoHandlers.push(h);
    try {
      if (!b.handlers && !(b.isoHandlers && b.isoHandlers.some((h) => h.how !== 'continue'))) return yield* execList(b.body, fr);
      const tx = fr.ctx.tx;
      const sp = subBegin(fr.s, tx);
      fr.subDepth = (fr.subDepth || 0) + 1;
      let r;
      try { r = yield* execList(b.body, fr); }
      catch (e) {
        fr.subDepth--;
        if (!catchable(e)) { subEnd(fr.s, tx, sp, false); throw e; }
        const h = b.handlers ? b.handlers.find((x) => x.conds.some((c) => condMatch(c, e))) : null;
        const ih = !h && b.isoHandlers ? b.isoHandlers.find((x) => x.how !== 'continue' && x.conds.some((c) => condMatch(c, e))) : null;
        if (!h && !ih) { subEnd(fr.s, tx, sp, false); throw e; }
        if (ih && ih.how === 'exit') subEnd(fr.s, tx, sp, true); else subEnd(fr.s, tx, sp, false);
        fr.s.db.bus.emit('psm.exception', { fn: fr.f.name, code: e.code, message: e.message });
        if (ih) { fr.isoHandlers.length = saveIso; const x = yield* runIsoHandler(fr, ih, e); return x && x !== RET && (x.exit !== undefined || x.cont !== undefined) ? x : x === RET ? RET : null; }
        fr.slots[h.state].value = e.code;
        fr.slots[h.errm].value = e.message;
        fr.errs.push(e);
        try { return yield* execList(h.body, fr); } finally { fr.errs.pop(); }
      }
      fr.subDepth--;
      subEnd(fr.s, tx, sp, true);
      return r;
    } finally { fr.isoHandlers.length = saveIso; }
  }
  const catchable = (e) => e instanceof K.DBError && !e.crash && e.code !== S.queryCanceled;
  function condMatch(c, e) {
    if (c.others) return e.code !== 'P0004' && e.code !== S.queryCanceled;
    if (c.sqlexception) return !/^0[012]/.test(e.code);
    if (c.code.endsWith('000') && c.code !== 'P0000') return e.code.slice(0, 2) === c.code.slice(0, 2);
    if (c.code === 'P0000') return e.code.startsWith('P0');
    return e.code === c.code;
  }
  function isoHandler(fr, e, how) {
    if (!catchable(e)) return null;
    for (let i = fr.isoHandlers.length - 1; i >= 0; i--) { const h = fr.isoHandlers[i]; if (h.conds.some((c) => condMatch(c, e))) return h.how === how ? h : null; }
    return null;
  }
  function* runIsoHandler(fr, h, e) {
    fr.errs.push(e);
    try { const r = yield* execList(h.body, fr); return r === RET ? RET : null; } finally { fr.errs.pop(); }
  }
  /** SQL/PSM: no row for SELECT INTO or FETCH is the NOT FOUND condition, which a handler may catch */
  function notFound(fr) {
    if (!fr.c.iso) return;
    const e = K.err('02000', 'no data');
    for (let i = fr.isoHandlers.length - 1; i >= 0; i--) if (fr.isoHandlers[i].conds.some((c) => condMatch(c, e))) throw e;
  }

  function* execForInt(st, fr) {
    const lo = evalE(st.lo, fr); const lt = fr.lt;
    if (lo === null) throw K.err('22004', 'lower bound of FOR loop cannot be null');
    const hi = evalE(st.hi, fr); const ht = fr.lt;
    if (hi === null) throw K.err('22004', 'upper bound of FOR loop cannot be null');
    let by = 1;
    if (st.by) { const b = evalE(st.by, fr); if (b === null) throw K.err('22004', 'BY value of FOR loop cannot be null'); by = toInt(b, fr.lt, fr.ctx); if (by <= 0) throw K.err('22023', 'BY value of FOR loop must be greater than zero'); }
    const a = toInt(lo, lt, fr.ctx), z = toInt(hi, ht, fr.ctx);
    const sl = fr.slots[st.slot];
    let found = false;
    for (let i = a; st.reverse ? i >= z : i <= z; i += st.reverse ? -by : by) {
      sl.value = i;
      found = true;
      const r = yield* execList(st.body, fr);
      if (r) { const x = loopCtl(r, st); if (x === 1) break; if (x === 2) continue; fr.found(true); return x; }
    }
    fr.found(found);
    return null;
  }
  function* queryRows(st, fr) {
    if (st.dyn) return yield* dynRows(st.dyn, fr);
    if (st.cursor !== undefined) {
      const info = fr.slots[st.cursor].info.cursor;
      bindCursorArgs(fr, info, st.args);
      const c = prepSql(info.query, fr);
      return { rows: yield* runPlanG(c, fr, 0), cols: c.cols, rec: c.rec };
    }
    const c = prepSql(st.query, fr);
    return { rows: yield* runPlanG(c, fr, 0), cols: c.cols, rec: c.rec };
  }
  function* execForQuery(st, fr) {
    const q = yield* queryRows(st, fr);
    let found = false;
    let curName = null;
    if (st.cursor !== undefined) {
      curName = fr.slots[st.cursor].value || fr.slots[st.cursor].info.name;
      if (fr.s.cursors.has(curName)) throw K.err('42P03', 'cursor "' + curName + '" already in use');
      fr.s.cursors.set(curName, makeCursor(curName, q, true));
    }
    try {
      for (const row of q.rows) {
        found = true;
        if (st.isoAs) { const sl = fr.slots[st.targets[0].slot]; fr.setType(sl, q.rec); sl.value = new K.RowV(row, q.rec); }
        else assignRow(fr, st.targets, row, q.cols, q.rec);
        const r = yield* execList(st.body, fr);
        if (r) { const x = loopCtl(r, st); if (x === 1) break; if (x === 2) continue; fr.found(true); return x; }
      }
    } finally { if (curName) fr.s.cursors.delete(curName); }
    fr.found(found);
    return null;
  }
  function* execForeach(st, fr) {
    const a = evalE(st.arr, fr);
    const at = fr.lt;
    if (a === null) throw K.err('22004', 'FOREACH expression must not be null');
    if (!(a instanceof K.ArrayV)) throw K.err(S.datatypeMismatch, 'FOREACH expression must yield an array, not type ' + T().sqlName(at));
    const dims = a.dims().length;
    if (st.slice < 0 || st.slice > dims) throw K.err(S.arraySubscript, 'slice dimension (' + st.slice + ') is out of the valid range 0..' + dims);
    let items;
    if (st.slice === 0) items = K.Expr.flat(a);
    else { items = []; const walk = (x, d) => { if (d === st.slice) { items.push(new K.ArrayV(x.items.slice())); return; } for (const y of x.items) walk(y, d - 1); }; walk(a, dims); }
    const et = st.slice === 0 ? at.elem : at;
    let found = false;
    for (const v of items) {
      found = true;
      if (st.targets.length > 1 || (st.targets.length === 1 && v instanceof K.RowV && fr.slots[st.targets[0].slot].info.kind !== 'record' && fr.slots[st.targets[0].slot].info.kind !== 'row')) {
        const vals = v instanceof K.RowV ? v.values : [v];
        st.targets.forEach((t, i) => assign(fr, t, vals[i] === undefined ? null : vals[i], et && et.fields ? et.fields[i].type : null));
      } else assign(fr, st.targets[0], v, et);
      const r = yield* execList(st.body, fr);
      if (r) { const x = loopCtl(r, st); if (x === 1) break; if (x === 2) continue; fr.found(true); return x; }
    }
    fr.found(found);
    return null;
  }

  // ---- RETURN ---------------------------------------------------------------------------------------------------------
  function resultCols(f) {
    if (f.returnsTable) return f.retType.fields;
    const outs = f.params.filter((p) => p.mode === 'out' || p.mode === 'inout');
    if (outs.length > 1) return outs.map((p) => ({ name: p.name, type: p.type }));
    if (outs.length === 1) return [{ name: outs[0].name, type: outs[0].type }];
    if (isComposite(f.retType)) return f.retType.fields;
    return [{ name: f.name, type: f.retType }];
  }
  function execReturn(st, fr) {
    if (st.expr) {
      let v = evalE(st.expr, fr);
      const vt = fr.lt;
      if (fr.trig) {
        if (v !== null && !(v instanceof K.RowV)) throw K.err(S.datatypeMismatch, 'returned row structure does not match the structure of the triggering table');
        fr.retVal = v;
        return RET;
      }
      const rt = fr.f.retType;
      if (rt && rt.id === 'record' && !rt.fields) { if (v !== null && !(v instanceof K.RowV)) throw K.err(S.datatypeMismatch, 'cannot return non-composite value from function returning composite type'); }
      else if (isComposite(rt)) {
        if (v !== null && !(v instanceof K.RowV)) throw K.err(S.datatypeMismatch, 'cannot return non-composite value from function returning composite type');
        v = coerceTo(v, vt, rt, fr.ctx);
      } else v = coerceTo(v, vt, rt, fr.ctx);
      fr.retVal = v;
    }
    return RET;
  }
  function outRow(fr) { return fr.c.outs.map((i) => fr.slots[i].value); }
  function pushRow(fr, vals, types) {
    const cols = resultCols(fr.f);
    if (vals.length !== cols.length) throw K.err(S.datatypeMismatch, 'structure of query does not match function result type', { detail: 'Number of returned columns (' + vals.length + ') does not match expected column count (' + cols.length + ').' });
    (fr.out || (fr.out = [])).push(vals.map((v, i) => coerceTo(v, types ? types[i] : null, cols[i].type, fr.ctx)));
  }
  function execReturnNext(st, fr) {
    if (!st.expr) { pushRow(fr, outRow(fr), fr.c.outs.map((i) => fr.slots[i].type)); return; }
    const v = evalE(st.expr, fr);
    const vt = fr.lt;
    const cols = resultCols(fr.f);
    const composite = fr.f.returnsTable || cols.length > 1 || isComposite(fr.f.retType);
    if (composite) {
      if (v === null) { pushRow(fr, cols.map(() => null)); return; }
      if (!(v instanceof K.RowV)) throw K.err(S.datatypeMismatch, 'wrong record type supplied in RETURN NEXT');
      const ft = v.type && v.type.fields ? v.type.fields.map((x) => x.type) : vt && vt.fields ? vt.fields.map((x) => x.type) : null;
      if (v.values.length !== cols.length) throw K.err(S.datatypeMismatch, 'wrong record type supplied in RETURN NEXT', { detail: 'Number of returned columns (' + v.values.length + ') does not match expected column count (' + cols.length + ').' });
      pushRow(fr, v.values, ft);
    } else pushRow(fr, [v], [vt]);
  }
  function* execReturnQuery(st, fr) {
    let q;
    if (st.dyn) q = yield* dynRows(st.dyn, fr);
    else { const c = prepSql(st.query, fr); q = { rows: yield* runPlanG(c, fr, 0), cols: c.cols }; }
    const cols = resultCols(fr.f);
    if (q.cols.length !== cols.length) throw K.err(S.datatypeMismatch, 'structure of query does not match function result type', { detail: 'Number of returned columns (' + q.cols.length + ') does not match expected column count (' + cols.length + ').' });
    q.cols.forEach((c, i) => { const want = cols[i].type; const got = c.type && c.type.domain ? c.type.base : c.type; if (want && got && got.cat !== 'P' && want.cat !== 'P' && got.id !== (want.domain ? want.base : want).id) throw K.err(S.datatypeMismatch, 'structure of query does not match function result type', { detail: 'Returned type ' + T().sqlName(c.type) + ' does not match expected type ' + T().sqlName(want) + ' in column ' + (i + 1) + '.' }); });
    for (const r of q.rows) pushRow(fr, r, q.cols.map((c) => c.type));
    fr.rowCount = q.rows.length;
    fr.found(q.rows.length > 0);
  }

  // ---- RAISE ------------------------------------------------------------------------------------------------------------
  function execRaise(st, fr) {
    if (st.reraise) {
      const e = fr.errs[fr.errs.length - 1];
      if (!e) throw K.err('0Z002', 'RAISE without parameters cannot be used outside an exception handler');
      throw e;
    }
    const txt = (v, t) => (v === null ? null : typeof v === 'string' ? v : T().output(v, t || T().typeOfValue(v), fr.ctx));
    let msg = null;
    if (st.fmt !== null) {
      const vals = st.args.map((a) => { const v = evalE(a, fr); return v === null ? '<NULL>' : txt(v, fr.lt); });
      let k = 0;
      msg = st.fmt.replace(/%%|%/g, (m) => (m === '%%' ? '%' : vals[k++]));
    }
    const extra = {};
    let code = st.sqlstate || (st.cond ? CONDITIONS[st.cond] : null);
    for (const o of st.opts) {
      const v = evalE(o.e, fr);
      if (v === null) throw K.err('22004', 'RAISE statement option cannot be null');
      const s = txt(v, fr.lt);
      if (o.o === 'message') msg = s;
      else if (o.o === 'errcode') { if (/^[0-9A-Z]{5}$/.test(s)) code = s; else if (CONDITIONS[s]) code = CONDITIONS[s]; else throw K.err(S.undefinedObject, 'unrecognized exception condition "' + s + '"'); }
      else extra[o.o] = s;
    }
    if (st.level === 'exception') {
      if (!code) code = 'P0001';
      if (msg === null) msg = st.condName || st.cond || (st.sqlstate ? st.sqlstate : CODE_NAMES.get(code) || code);
      const e = K.err(code, msg, extra);
      e.raised = true;
      throw e;
    }
    if (msg === null) msg = st.cond || st.sqlstate || '';
    fr.s.notice(msg, st.level.toUpperCase());
    const last = fr.s.notices[fr.s.notices.length - 1];
    if (last) Object.assign(last, extra);
  }

  // ---- SQL statements ---------------------------------------------------------------------------------------------------
  function* execSql(st, fr) {
    if (st.kind === 'call') return yield* execCall(st, fr);
    if (st.kind === 'utility') { yield* runUtility(st.ast, fr); return null; }
    if (st.ast.type === 'merge') {
      if (!st.into && st.ast.returning) throw K.err(S.syntax, 'query has no destination for result data');
      return yield* execMerge(st, fr);
    }
    const c = prepSql(st, fr);
    const isQuery = st.kind === 'query';
    if (!st.into && !st.perform && c.cols.length && (isQuery || st.ast.returning)) throw K.err(S.syntax, 'query has no destination for result data', { hint: isQuery ? 'If you want to discard the results of a SELECT, use PERFORM instead.' : null });
    const limit = st.into ? (st.into.strict || !isQuery ? 2 : 1) : 0;
    const rows = yield* runPlanG(c, fr, isQuery ? limit : 0);
    const n = isQuery ? rows.length : fr.lastCount;
    fr.rowCount = n;
    if (st.into) {
      if (st.into.strict || !isQuery) {
        if (rows.length > 1) throw K.err('P0003', 'query returned more than one row', { hint: !isQuery ? null : 'Make sure the query returns a single row, or use LIMIT 1.' });
        if (st.into.strict && !rows.length) throw K.err('P0002', 'query returned no rows');
      }
      if (!rows.length) notFound(fr);
      assignRow(fr, st.into.targets, rows[0] || null, c.cols, c.rec);
      fr.found(rows.length > 0);
      return null;
    }
    fr.found(n > 0);
    return null;
  }
  function* execMerge(st, fr) {
    if (!K.Merge) throw K.err(S.featureNotSupported, 'MERGE is not supported');
    const r = yield* withCidG(fr, (function* () { const ctx = stmtCtx(fr, null); return yield* K.Merge.run(fr.s, st.ast, ctx, { binderFor: () => binderFor(fr, st.scope) }); })());
    fr.rowCount = r.count || 0;
    if (st.into) {
      if (r.rows && r.rows.length > 1) throw K.err('P0003', 'query returned more than one row');
      if (st.into.strict && !(r.rows && r.rows.length)) throw K.err('P0002', 'query returned no rows');
      assignRow(fr, st.into.targets, r.rows && r.rows[0] || null, r.cols || [], recType(r.cols || []));
    }
    fr.found(fr.rowCount > 0);
    return null;
  }
  function* runUtility(ast, fr) {
    const s = fr.s;
    return yield* withCidG(fr, (function* () {
      if (['set', 'reset', 'show'].includes(ast.type)) return s[ast.type](ast);
      if (['begin', 'savepoint', 'release', 'rollbackTo', 'commit', 'rollback', 'setTransaction'].includes(ast.type)) throw K.err(S.featureNotSupported, 'unsupported transaction command in PL/pgSQL');
      if (ast.type === 'do') { yield* doInlineG(ast, fr.ctx, s, true); return null; }
      return yield* s.inTx(ast, [], {});
    })());
  }
  /** CALL inside a procedure or function: INOUT and OUT arguments go back into the variables passed for them */
  function* execCall(st, fr) {
    const s = fr.s;
    const ast = st.ast;
    const list = s.catalog.userFuncs(ast.name.name).filter((f) => f.kind === 'procedure');
    if (!list.length) throw K.err(S.undefinedFunction, 'procedure ' + ast.name.name + '() does not exist', { hint: 'No procedure matches the given name and argument types. You might need to add explicit type casts.' });
    const argAsts = ast.args.map((a) => a.expr || a);
    const p = list.find((x) => x.params.length >= argAsts.length && x.params.filter((y) => y.mode !== 'out' && y.default === undefined).length <= argAsts.length) || list[0];
    const exprs = st.argExprs || (st.argExprs = argAsts.map((a, i) => ({ k: 'expr', text: 'argument ' + (i + 1), ast: { type: 'select', targets: [{ expr: a }], from: [] }, scope: st.scope })));
    const vals = [];
    const back = [];
    p.params.forEach((pm, i) => {
      const e = exprs[i];
      if (pm.mode === 'out') { if (e) back.push({ i, e }); return; }
      let v = null, vt = null;
      if (e) { v = evalE(e, fr); vt = fr.lt; }
      else if (pm.default) { const de = { k: 'expr', text: 'default', ast: { type: 'select', targets: [{ expr: pm.default }], from: [] }, scope: null }; v = evalE(de, fr); vt = fr.lt; }
      vals.push(coerceTo(v, vt, pm.type, fr.ctx));
      if (pm.mode === 'inout' && e) back.push({ i, e });
    });
    const nonAtomic = fr.nonAtomic && !fr.subDepth;
    const r = yield* withCidG(fr, (function* () {
      const ctx = stmtCtx(fr, null);
      if (p.lang === 'sql') return s.callUdf(ctx, { fn: p }, vals);
      ctx.udfDepth = (ctx.udfDepth || 0) + 1;
      return yield* invokeG(p, vals, ctx, s, false, null, { nonAtomic });
    })());
    if (back.length && r instanceof K.RowV) {
      const outs = p.params.map((pm, i) => ({ pm, i })).filter((x) => x.pm.mode === 'out' || x.pm.mode === 'inout');
      for (const b of back) {
        const k = outs.findIndex((x) => x.i === b.i);
        const a = argAsts[b.i];
        if (!a || a.k !== 'col') throw K.err(S.syntax, 'procedure parameter "' + (p.params[b.i].name || b.i + 1) + '" is an output parameter but corresponding argument is not writable');
        const hit = resolveParts(st.scope, a.parts);
        if (!hit) throw K.err(S.syntax, 'procedure parameter "' + (p.params[b.i].name || b.i + 1) + '" is an output parameter but corresponding argument is not writable');
        assign(fr, { slot: hit.slot, path: hit.fields.map((f) => ({ field: f })) }, r.values[k], p.params[b.i].type);
      }
    }
    return null;
  }
  function* execTxEnd(st, fr) {
    if (!fr.nonAtomic) throw K.err(S.invalidTransactionTermination, 'invalid transaction termination');
    if (fr.subDepth) throw K.err(S.invalidTransactionTermination, 'cannot ' + st.k + ' while a subtransaction is active');
    const s = fr.s;
    const tx = fr.ctx.tx;
    const iso = tx.isolation, ro = tx.readOnly;
    if (st.k === 'commit') yield* s.commitTx(tx); else s.abortTx(tx);
    // the same transaction object carries on as the next transaction, so the statement running CALL still holds it
    const n = s.beginTx(true, st.chain ? { isolation: iso, readOnly: ro } : {});
    s.db.xact.active.delete(n.id);
    const g = cidGuard(tx);
    for (const k of Object.keys(n)) if (k !== 'cid') tx[k] = n[k];
    g.set(0); g.high = 0;
    tx.implicit = true;
    s.db.xact.active.set(tx.id, tx);
    s.tx = tx;
    s.db.bus.emit('psm.' + st.k, { fn: fr.f.name });
  }

  // ---- dynamic SQL ---------------------------------------------------------------------------------------------------
  function prepDynamic(str, types, fr) {
    const cat = fr.s.catalog;
    const key = str + '\u0000' + types.map((t) => (t ? tkey(t) : '?')).join(',');
    const cache = fr.c.dyn || (fr.c.dyn = new Map());
    const hit = cache.get(key);
    if (hit && hit.cat === cat && hit.ver === cat.version) return hit;
    const stmts = K.parse(str);
    if (!stmts.length) throw K.err(S.syntax, 'cannot execute an empty query string');
    if (stmts.length > 1) throw K.err(S.syntax, 'cannot insert multiple commands into a prepared statement');
    const ast = stmts[0];
    let c;
    if (['select', 'values', 'setop', 'insert', 'update', 'delete'].includes(ast.type)) {
      if (ast.type === 'select' && ast.into) throw K.err(S.featureNotSupported, 'EXECUTE of SELECT ... INTO is not implemented', { hint: 'You might want to use EXECUTE ... INTO or EXECUTE CREATE TABLE ... AS instead.' });
      const { plan, planner } = fr.s.plan(ast, { paramTypes: types });
      const cols = plan.cols.filter((x) => !x.hidden);
      c = { plan, planner, cols, rec: recType(cols), query: ast.type !== 'insert' && ast.type !== 'update' && ast.type !== 'delete' };
    } else c = { utility: true, ast };
    c.cat = cat; c.ver = cat.version;
    if (cache.size > 64) cache.clear();
    cache.set(key, c);
    return c;
  }
  function dynArgs(d, fr) {
    const vals = [], types = [];
    for (const e of d.using) { vals.push(evalE(e, fr)); types.push(fr.lt && fr.lt.cat === 'P' ? B().text : fr.lt); }
    const str = evalE(d.expr, fr);
    if (str === null) throw K.err('22004', 'query string argument of EXECUTE is null');
    return { str: String(str), vals, types };
  }
  function* dynRows(d, fr) {
    const a = dynArgs(d, fr);
    const c = prepDynamic(a.str, a.types, fr);
    if (c.utility || !c.query) throw K.err(S.featureNotSupported, 'cannot open a non-SELECT query as a cursor');
    return { rows: yield* runPlanG(c, fr, 0, a.vals), cols: c.cols, rec: c.rec };
  }
  function* execDynamic(st, fr) {
    const a = dynArgs(st, fr);
    const c = prepDynamic(a.str, a.types, fr);
    if (c.utility) {
      if (st.into) throw K.err(S.syntax, 'EXECUTE of a utility statement cannot have INTO');
      yield* runUtility(c.ast, fr);
      fr.rowCount = 0;
      return;
    }
    const rows = yield* runPlanG(c, fr, st.into && c.query ? 2 : 0, a.vals);
    fr.rowCount = c.query ? rows.length : fr.lastCount;
    if (st.into) {
      if (!c.cols.length) throw K.err(S.syntax, 'INTO used with a command that cannot return data');
      if (rows.length > 1 && (st.into.strict || !c.query)) throw K.err('P0003', 'query returned more than one row');
      if (!rows.length && st.into.strict) throw K.err('P0002', 'query returned no rows');
      assignRow(fr, st.into.targets, rows[0] || null, c.cols, c.rec);
    }
  }

  // ---- GET DIAGNOSTICS ---------------------------------------------------------------------------------------------------
  function execGetDiag(st, fr) {
    const e = st.stacked ? fr.errs[fr.errs.length - 1] : null;
    if (st.stacked && !e) throw K.err('0Z002', 'GET STACKED DIAGNOSTICS cannot be used outside an exception handler');
    for (const it of st.items) {
      let v, t = B().text;
      switch (it.item) {
        case 'row_count': v = BigInt(fr.rowCount || 0); t = B().int8; break;
        case 'pg_context': v = fr.where(fr.curStmt || null); break;
        case 'pg_routine_oid': v = fr.f.oid || 0; t = B().int4; break;
        case 'returned_sqlstate': v = e.code; break;
        case 'message_text': v = e.message; break;
        case 'pg_exception_detail': v = e.detail || ''; break;
        case 'pg_exception_hint': v = e.hint || ''; break;
        case 'pg_exception_context': v = e.context || ''; break;
        case 'column_name': v = e.column || ''; break;
        case 'constraint_name': v = e.constraint || ''; break;
        case 'table_name': v = e.table || ''; break;
        case 'schema_name': v = e.schema || (e.table ? 'public' : ''); break;
        case 'pg_datatype_name': v = e.datatype || ''; break;
      }
      assign(fr, it.target, v, t);
    }
  }

  // ---- cursors -----------------------------------------------------------------------------------------------------------
  let portalN = 0;
  /** a cursor as the session keeps them (so SQL FETCH works on it too); its rows are read when it is opened */
  function makeCursor(name, q, scroll) {
    return {
      name, scroll: scroll !== false, hold: false, cols: q.cols, buf: q.rows, pos: 0, done: true, it: null, plan: null,
      pull() { return null; },
      currentTid(rel) { const r = this.buf[this.pos - 1]; if (!r || !r.tid || r.rel.oid !== rel.oid) throw K.err('24000', 'cursor "' + this.name + '" is not positioned on a row'); return '(' + r.tid.b + ',' + r.tid.o + ')'; },
    };
  }
  function bindCursorArgs(fr, info, args) {
    info.args.forEach((slot, i) => { const v = evalE(args[i], fr); setSlot(fr, slot, v, fr.lt); });
  }
  function* execOpen(st, fr) {
    const sl = fr.slots[st.cur];
    let q, scroll = st.scroll;
    if (st.bound) {
      const info = sl.info.cursor;
      bindCursorArgs(fr, info, st.args);
      const c = prepSql(info.query, fr);
      q = { rows: yield* runPlanG(c, fr, 0), cols: c.cols };
      scroll = info.scroll;
    } else if (st.dyn) q = yield* dynRows(st.dyn, fr);
    else { const c = prepSql(st.query, fr); q = { rows: yield* runPlanG(c, fr, 0), cols: c.cols }; }
    let name = sl.value;
    if (name === null) { name = '<unnamed portal ' + ++portalN + '>'; sl.value = name; }
    if (fr.s.cursors.has(name)) throw K.err('42P03', 'cursor "' + name + '" already in use');
    fr.s.cursors.set(name, makeCursor(name, q, scroll));
  }
  function execFetch(st, fr) {
    const name = fr.slots[st.cur].value;
    if (name === null) throw K.err('22004', 'cursor variable "' + fr.slots[st.cur].info.name + '" is null');
    if (!fr.s.cursors.has(name)) throw K.err(S.invalidCursor, 'cursor "' + name + '" does not exist');
    let count = 1;
    if (st.count === 'all') count = Infinity;
    else if (st.count) { const v = evalE(st.count, fr); count = v === null ? 0 : Number(toInt(v, fr.lt, fr.ctx)); }
    const r = fr.s.fetchCursor({ name, dir: st.dir, count, move: st.move });
    const c = fr.s.cursors.get(name);
    if (st.move) { fr.rowCount = r.count; fr.found(r.count > 0); return; }
    const row = r.rows[0] || null;
    fr.rowCount = row ? 1 : 0;
    if (!row) notFound(fr);
    assignRow(fr, st.into.targets, row, c.cols, recType(c.cols));
    fr.found(!!row);
  }

  // ---- calling --------------------------------------------------------------------------------------------------------------
  function ensure(f) {
    if (!f.compiled || !f.compiled.plpgsql) f.compiled = compile(f, null);
    return f.compiled;
  }
  /** run a function or procedure; returns its value (an array of rows for a set-returning call) */
  function* invokeG(f, args, ctx, s, wantSet, trig, opts) {
    opts = opts || {};
    const comp = ensure(f);
    const depth = (ctx.plDepth || 0) + 1;
    if (depth > 150) throw K.err('54001', 'stack depth limit exceeded', { hint: 'A function or trigger is calling itself without end.' });
    const fr = new Frame(f, comp, s, ctx);
    fr.ctx.plDepth = depth;
    fr.trig = trig;
    fr.nonAtomic = !!opts.nonAtomic;
    for (const p of comp.params) {
      const sl = fr.slots[p.slot];
      if (p.mode === 'out') { sl.value = sl.info.kind === 'row' && sl.type && sl.type.fields ? new K.RowV(sl.type.fields.map(() => null), sl.type) : null; continue; }
      let v = args[sl.info.argIndex];
      const pm = f.params.find((x, k) => k === comp.params.indexOf(p));
      if (v === undefined && pm && pm.default) v = coerceTo(defaultValue(pm.default, fr), fr.lt, sl.type, fr.ctx);
      sl.value = v === undefined ? null : v;
      if (sl.info.kind === 'auto') fr.setType(sl, v === null || v === undefined ? B().text : v instanceof K.RowV && v.type ? v.type : T().typeOfValue(v));
    }
    for (const i of comp.outs) if (fr.slots[i].info.param === 'out' && fr.slots[i].value === undefined) fr.slots[i].value = null;
    fr.found(false);
    if (trig) setupTrigger(fr, trig);
    else if (comp.tg) throw K.err(S.featureNotSupported, 'trigger functions can only be called as triggers');
    s.db.bus.emit('psm.call', { fn: f.name, depth });
    let r;
    try { r = yield* execBlock(comp.body, fr); }
    catch (e) {
      if (e instanceof RangeError && /call stack/i.test(e.message)) throw K.err('54001', 'stack depth limit exceeded', { hint: 'A function or trigger is calling itself without end.' });
      throw e;
    }
    if (trig) {
      if (r !== RET) throw K.err('2F005', 'control reached end of trigger procedure without RETURN');
      return r === RET ? fr.retVal : null;
    }
    if (f.kind === 'procedure') {
      if (!comp.outs.length) return null;
      const outs = f.params.filter((p) => p.mode === 'out' || p.mode === 'inout');
      return new K.RowV(outRow(fr), { id: 'record', name: 'record', cat: 'C', len: -1, fields: outs.map((p) => ({ name: p.name, type: p.type })) });
    }
    if (f.setof) {
      const rows = fr.out || [];
      if (wantSet) return rows;
      if (!rows.length) return null;
      const cols = resultCols(f);
      return cols.length > 1 || f.returnsTable || isComposite(f.retType) ? new K.RowV(rows[0], f.retType) : rows[0][0];
    }
    if (comp.outs.length) {
      if (comp.outs.length === 1) return fr.slots[comp.outs[0]].value;
      return new K.RowV(outRow(fr), f.retType);
    }
    if (r === RET) return fr.retVal === undefined ? (f.retType && f.retType.id === 'void' ? '' : null) : fr.retVal;
    if (f.retType && f.retType.id === 'void') return '';
    const e = K.err('2F005', 'control reached end of function without RETURN');
    e.context = 'PL/pgSQL function ' + f.name + '()';
    throw e;
  }
  function defaultValue(ast, fr) {
    const b = new K.Binder(fr.s);
    const e = b.expr(ast, new K.Scope(null), {});
    fr.lt = e.type;
    return K.Expr.compile(e, new Map())([], fr.ctx);
  }
  const invoke = (f, args, ctx, s, wantSet, trig, opts) => drainValue(invokeG(f, args, ctx, s, wantSet, trig, opts));
  /** a call from an expression: it runs to its end (a lock wait inside it is an error) */
  function call(f, args, ctx, s, wantSet) {
    const r = invoke(f, args, ctx, s, wantSet, null, { nonAtomic: false });
    if (wantSet && !Array.isArray(r)) return r === null ? [] : [r instanceof K.RowV ? r.values : [r]];
    return r;
  }
  /** CALL: a procedure called outside an explicit transaction block may COMMIT and ROLLBACK, and may wait for locks */
  function* callG(f, args, ctx, s) {
    const nonAtomic = f.kind === 'procedure' && ctx.tx && ctx.tx.implicit && (ctx.udfDepth || 0) <= 1 && !ctx.plDepth;
    return yield* invokeG(f, args, ctx, s, false, null, { nonAtomic });
  }
  function* doInlineG(st, ctx, s, nested) {
    const f = { name: 'inline_code_block', kind: 'procedure', params: [], retType: null, lang: 'plpgsql', body: st.body, bodyPos: st.bodyPos };
    f.compiled = compile(f, s);
    return yield* invokeG(f, [], ctx, s, false, null, { nonAtomic: !nested && ctx.tx && ctx.tx.implicit });
  }
  const doInline = (st, ctx, s, nested) => drainValue(doInlineG(st, ctx, s, nested));
  /** a trigger's data in its frame: NEW, OLD, TG_*; transition tables appear as tables */
  function setupTrigger(fr, td) {
    const tg = fr.c.tg;
    if (!tg) throw K.err(S.featureNotSupported, 'trigger functions can only be called as triggers');
    const set = (k, v) => { fr.slots[tg[k]].value = v; };
    for (const which of ['new', 'old']) {
      const sl = fr.slots[tg[which]];
      fr.setType(sl, td.rowType);
      sl.value = td[which] ? new K.RowV(td[which], td.rowType) : null;
    }
    set('tg_name', td.name); set('tg_when', td.when); set('tg_level', td.level); set('tg_op', td.op);
    set('tg_relid', td.rel.oid); set('tg_relname', td.rel.name); set('tg_table_name', td.rel.name); set('tg_table_schema', td.rel.schema);
    set('tg_nargs', td.args.length); set('tg_argv', new K.ArrayV(td.args.slice(), 0));
    if (td.transitions && td.transitions.length) {
      fr.ctes = new Map();
      fr.workTables = new Map();
      const cache = fr.c.transCtes || (fr.c.transCtes = new Map());
      for (const tt of td.transitions) {
        const key = tt.name + ':' + tkey(td.rowType);
        let cte = cache.get(key);
        if (!cte) { cte = { name: tt.name, cols: td.rowType.fields.map((x) => ({ name: x.name, type: x.type })), binding: true, recursive: false, refs: 0 }; cache.set(key, cte); }
        fr.ctes.set(tt.name, cte);
        fr.workTables.set(cte, tt.rows);
      }
      fr._sig = null;
      fr.sigExtra = [...fr.ctes.keys()].join(',');
    }
  }
  function* callTriggerG(f, td, ctx, s) {
    if (f.lang === 'sql') throw K.err(S.featureNotSupported, 'SQL functions cannot return type trigger');
    return yield* invokeG(f, [], ctx, s, false, td);
  }

  // ---- binding variables inside SQL --------------------------------------------------------------------------------------
  // Names in a statement resolve to columns first; one that is also a variable in scope is ambiguous, as with
  // PostgreSQL's default plpgsql.variable_conflict = error.
  const origColumn = K.Binder.prototype.column;
  K.Binder.prototype.column = function (e, scope, quiet) {
    const pl = this.pl;
    if (!pl || quiet) return origColumn.call(this, e, scope, quiet);
    const hit = resolveParts(pl.scope, e.parts);
    if (!hit) return origColumn.call(this, e, scope, quiet);
    const sl = pl.fr.slots[hit.slot];
    const kind = sl.info.kind;
    if (hit.fields.length && kind === 'scalar' && !isComposite(sl.type)) return origColumn.call(this, e, scope, quiet);
    let col = null;
    try { col = origColumn.call(this, e, scope, true); } catch (x) { col = null; }
    if (col) {
      const name = e.parts.join('.');
      if (e.parts[0].startsWith('$') || pl.fr.c.iso) return col;
      throw K.err(S.ambiguousColumn, 'column reference "' + name + '" is ambiguous', { pos: e.pos, detail: 'It could refer to either a PL/pgSQL variable or a table column.' });
    }
    let t = sl.type;
    if (!t && kind === 'record') {
      if (hit.fields.length || sl.value === null) throw K.err('55000', 'record "' + sl.info.name + '" is not assigned yet', { detail: 'The tuple structure of a not-yet-assigned record is indeterminate.', pos: e.pos });
    }
    if (!t) t = kind === 'record' ? B().record : B().unknown;
    let node = { k: 'call', def: varDef(hit.slot), args: [], type: t, name: '#' + hit.slot, pos: e.pos };
    for (const fname of hit.fields) {
      if (!t || !t.fields) throw K.err(S.undefinedColumn, 'missing FROM-clause entry for table "' + e.parts[0] + '"', { pos: e.pos });
      const k = t.fields.findIndex((x) => x.name === fname);
      if (k < 0) throw K.err(S.undefinedColumn, 'record "' + sl.info.name + '" has no field "' + fname + '"', { pos: e.pos });
      node = { k: 'field', e: node, index: k, type: t.fields[k].type, name: fname };
      t = t.fields[k].type;
    }
    return node;
  };

  // SQL-language functions with a procedural BEGIN ATOMIC body (SQL/PSM) run here
  if (K.DDL) {
    const origCreate = K.DDL.prototype.createRoutine;
    K.DDL.prototype.createRoutine = function* (st, ctx, cat, s) {
      if (st.lang === 'sql' && (st.psmBody || (st.atomic && st.body && isProcedural(st.body)))) st = Object.assign({}, st, { lang: 'psm' });
      return yield* origCreate.call(this, st, ctx, cat, s);
    };
  }

  // refcursor: a cursor's name, as text
  if (K.Catalog) {
    const origUserType = K.Catalog.prototype.userType;
    let refcursor = null;
    K.Catalog.prototype.userType = function (name, path) {
      const t = origUserType.call(this, name, path);
      if (t || K.lower(name) !== 'refcursor') return t;
      return refcursor || (refcursor = Object.assign({}, B().text, { name: 'refcursor', refcursor: true }));
    };
  }

  K.PSM = { compile, call, callG, callTriggerG, doInline, doInlineG, invokeG, coerceTo, CONDITIONS, isProcedural, binderFor, drain, drainValue, cidGuard, withCid, subBegin, subEnd };
})(typeof window !== 'undefined' ? window : globalThis);
