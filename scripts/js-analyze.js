let nextSymId = 0;
let localFile, fileIndex, mozSearchRoot;

function logError(msg)
{
  printErr("ERROR " + msg + "\n");
}

function SymbolTable()
{
  this.table = new Map();
}

SymbolTable.prototype = {
  put(name, symbol) {
    this.table.set(name, symbol);
  },

  get(name) {
    return this.table.get(name);
  },
};

SymbolTable.Symbol = function(name, loc)
{
  this.name = name;
  this.loc = loc;
  this.id = fileIndex + "-" + nextSymId++;
  this.uses = [];
  this.skip = false;
}

SymbolTable.Symbol.prototype = {
  use(loc) {
    this.uses.push(loc);
  },
};

function posBefore(pos1, pos2) {
  return pos1.line < pos2.line ||
         (pos1.line == pos2.line && pos1.column < pos2.column);
}

function locBefore(loc1, loc2) {
  return posBefore(loc1.start, loc2.start);
}

function locstr(loc)
{
  return `${loc.start.line}:${loc.start.column}`;
}

function locstr2(loc, str)
{
  return `${loc.start.line}:${loc.start.column}-${loc.start.column + str.length}`;
}

function locstrFull(startPos, endPos)
{
  return `${startPos.line}:${startPos.column}-${endPos.line}:${endPos.column}`;
}

/**
 * Given an ESTree node, return true if it's potentially something that should
 * generate a nestingRange.  For our purposes, this means something that has
 * curly braces and is likely to span more than a single line of text.
 *
 * In the future this method might need to return the appropriate Location to
 * use rather than a boolean.  Right now the caller is expected to use the `loc`
 * of the provided node if we return true.
 */
function isNestingNode(node) {
  if (!node || !node.type) {
    return false
  }

  switch (node.type) {
    case "BlockStatement":
    case "FunctionExpression":
    case "ObjectExpression":
    case "ObjectPattern":
      return true;
    default:
      return false;
  }
}

function nameValid(name)
{
  if (!name) {
    return false;
  }
  for (var i = 0; i < name.length; i++) {
    var c = name.charCodeAt(i);
    switch (c) {
      case 0:  // '\0'
      case 10: // '\n'
      case 13: // '\r'
      case 32: // ' '
      case 34: // '"'
      case 92: // '\\'
        return false;
    }

    // If we have a Unicode surrogate character, make sure
    // it is a part of a valid surrogate pair, otherwise return false.

    if (c < 0xD800) {
      // Optimize common case
      continue;
    }
    if (c <= 0xDBFF && i + 1 < name.length) {
      // c is a high surrogate, check to make sure next char is a low surrogate
      var d = name.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) {
        // valid; skip over the pair and continue
        i++;
        continue;
      }
    }
    // fail on any surrogate characters that weren't part of a pair
    if (c <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function memberPropLoc(expr)
{
  let idLoc = expr.loc;
  idLoc.start.line = idLoc.end.line;
  idLoc.start.column = idLoc.end.column - expr.property.name.length;
  return idLoc;
}

/**
 * Stateful singleton that assumes this script is run once per file.  General
 * structure is a imperative, recursive traversal of the
 * available-in-its-entirety JS AST.  There isn't really any streaming
 * processing and everything is kept on the stack.
 *
 * XBL is a special-case via `XBLParser`.  It is dealing with single atomic
 * chunks of JS that exist in namespace
 */
let Analyzer = {
  /**
   * The symbol table for the current scope.  When `enter` is invoked, the
   * current `symbols` table is pushed onto `symbolTableStack` and a new
   * SymbolTable is created and assigned to `symbols`.  When `exit` is invoked,
   * the current `symbols` table is discarded and replaced by popping
   * `symbolTableStack`.
   */
  symbols: new SymbolTable(),
  /**
   * Stack of `SymbolTable` instances corresponding to scopes that are reachable
   * from the current scope.  Does not include the immediate scope which is
   * found in `symbols`.
   */
  symbolTableStack: [],

  /**
   * Tracks the name of the current variable declaration so that qualified names
   * can be inferred.  When nesting occurs, the previous value is saved off on
   * the stack while call to recursive AST traversal occurs, and is restored on
   * the way out.  No attempt is currently made to infer deeply nested names,
   * just a single level, so this works as long as that assumption is okay.
   * (Note however that `contextStack` does track this nesting.)
   *
   * Specialization occurs for cases like "prototype".
   */
  nameForThis: null,
  /**
   * Tracks explicit ES "class" names.  As with `nameForThis`, nesting happens
   * on the stack so that context isn't lost, but those names are ignored for
   * symbol naming purposes.  (Note however that `contextStack` does track this
   * nesting.)
   */
  className: null,
  /**
   * Used to derive the "context" property for target records.  Whenever
   * `symbolTableStack`, `nameForThis`, or `className` are modified, the name
   * (possibly falsey) that is being used for the the thing is pushed.  When
   * traversing an ObjectExpression or ObjectPattern, the key is also pushed.
   * (Object "dictionaries" like `{ a: { b: 1 } }` create a name hierarchy for
   * "a.b" but do not create lexical scopes on their own.)
   */
  contextStack: [],

  // Program lines.  Initialized by parse.  Used for getting back to program
  // source given a SourceLocation/Position.  For JS files, this should be
  // populated once.  For XUL/XBL files that invoke parse() multiple times with
  // a new, non-consecutive `line` each time, the missing lines are padded out
  // with empty strings.
  _lines: [],

  /**
   * Given a position, find the first instance of the given string starting
   * after the position.
   */
  findStrAfterPosition(str, pos) {
    // (lines are 1-based)
    let lineText = this._lines[pos.line - 1];
    if (!lineText) {
      return null;
    }
    let idx = lineText.indexOf(str, pos.column);
    if (idx === -1) {
      return null;
    }
    return {
      line: pos.line,
      column: idx
    };
  },

  /**
   * If you've got some kind of outerNode like a ClassStatement where the left
   * brace comes after a node like its "id" node, use this.  The outerNode's
   * position gives the end Location and the first { found after the idNode
   * gives the start.  (Note that the end location is still chosen to be after
   * the right brace for consistency with BlockStatements.)
   */
  deriveLocationFromOuterNodeAndIdNode(outerNode, idNode) {
    let start = this.findStrAfterPosition('{', idNode.loc.end);
    if (!start) {
      return null;
    }

    return {
      start,
      end: outerNode.loc.end
    };
  },

  /**
   * Enter a new lexical scope, pushing both a new SymbolTable() to track
   * symbols defined in this scope, as well as pushing onto the contextStack
   * for "context" attribute generation purposes.
   */
  enter(name) {
    this.symbolTableStack.push(this.symbols);
    this.symbols = new SymbolTable();

    this.contextStack.push(name);
  },

  exit() {
    let old = this.symbols;
    this.symbols = this.symbolTableStack.pop();
    this.contextStack.pop();
    return old;
  },


  isToplevel() {
    return this.symbolTableStack.length == 0;
  },

  /**
   * Syntactic sugar helper to enter(name) the (potentially falsey) named
   * lexical scope, invoke the provided helper, then exit() the scope off the
   * scope/context stack.
   */
  scoped(name, f) {
    this.enter(name);
    f();
    this.exit();
  },

  get context() {
    return this.contextStack.filter(e => !!e).join(".");
  },

  dummyProgram(prog, args) {
    let stmt = prog.body[0];
    let expr = stmt.expression;

    for (let {name, skip} of args) {
      let sym = new SymbolTable.Symbol(name, null);
      sym.skip = true;
      this.symbols.put(name, sym);
    }

    if (expr.body.type == "BlockStatement") {
      this.statement(expr.body);
    } else {
      this.expression(expr.body);
    }
  },

  parse(text, filename, line) {
    let ast;
    try {
      ast = Reflect.parse(text, {loc: true, source: filename, line});

      let parsedLines = text.split('\n');

      if (line === 1) {
        this._lines = parsedLines;
      } else {
        // In the case of XUL/XBL, we are given random (processed) excerpts of
        // JS code with `line` representing the first line in the XML file where
        // the JS was sourced from.
        //
        // As such, we need to grow the array and insert the parsed lines so
        // that when we lookup the source JS from the AST the lines line up.
        let linesToInsert = line - this._lines.length - 1;
        while (linesToInsert-- > 0) {
          this._lines.push('');
        }
        this._lines.push(...parsedLines);
      }

    } catch (e) {
      logError(`Unable to parse JS file ${filename}:${line}.`);
      logError(`because ${e}: ${e.fileName}:${e.lineNumber}`);
      return null;
    }
    return ast;
  },

  program(prog) {
    for (let stmt of prog.body) {
      this.statement(stmt);
    }
  },

  // maybeNesting allows passing a SourceLocation directly or a Node.  The node
  // is tested via a call to `isNestingNode` to determine whether it's an
  // appropriate type for its `loc` to be used.  This allows callers to pass
  // nodes without first checking their type.
  source(loc, name, syntax, pretty, sym, no_crossref, maybeNesting) {
    let locProp;
    if (typeof(loc) == "object" && "start" in loc) {
      locProp = locstr2(loc, name);
    } else {
      locProp = loc;
    }
    let obj = {loc: locProp, source: 1, syntax, pretty, sym};
    if (no_crossref) {
      obj.no_crossref = 1;
    }
    if (maybeNesting) {
      let nestLoc;
      if (maybeNesting.start) {
        nestLoc = maybeNesting;
      } else if (isNestingNode(maybeNesting)) {
        nestLoc = maybeNesting.loc;
      }
      if (nestLoc) {
        // substract 1 off the end column so that it points at a
        // closing brace rather than just beyond the closing brace.  This is desired for
        // the nestingRange where the goal is to reference the opening and closing
        // brace tokens directly.
       let adjustedEnd = { line: nestLoc.end.line, column: nestLoc.end.column };
        adjustedEnd.column--;
        // Handle the case where we wrap to a previous line as well, ensuring we
        // don't wrap backwards past the start position.
        while (adjustedEnd.column < 0 && posBefore(nestLoc.start, adjustedEnd)) {
          adjustedEnd.line--;
          adjustedEnd.column = this._lines[adjustedEnd.line - 1].length - 1;
        }
        obj.nestingRange = locstrFull(nestLoc.start, adjustedEnd);
      }
    }
    print(JSON.stringify(obj));
  },

  target(loc, name, kind, pretty, sym) {
    let locProp;
    if (typeof(loc) == "object" && "start" in loc) {
      locProp = locstr2(loc, name);
    } else {
      locProp = loc;
    }
    print(JSON.stringify({loc: locProp, target: 1, kind, pretty, sym,
                          context: this.context}));
  },

  defProp(name, loc, extra, extraPretty, maybeNesting) {
    if (!nameValid(name)) {
      return;
    }
    this.source(loc, name, "def,prop", `property ${name}`, `#${name}`, false,
                maybeNesting);
    this.target(loc, name, "def", name, `#${name}`);
    if (extra) {
      this.source(loc, name, "def,prop", `property ${extraPretty}`, extra,
                  false, maybeNesting);
      this.target(loc, name, "def", extraPretty, extra);
    }
  },

  useProp(name, loc, extra, extraPretty) {
    if (!nameValid(name)) {
      return;
    }
    this.source(loc, name, "use,prop", `property ${name}`, `#${name}`, false);
    this.target(loc, name, "use", name, `#${name}`);
    if (extra) {
      this.source(loc, name, "use,prop", `property ${extraPretty}`, extra,
                  false);
      this.target(loc, name, "use", extraPretty, extra);
    }
  },

  assignProp(name, loc, extra, extraPretty, maybeNesting) {
    if (!nameValid(name)) {
      return;
    }
    this.source(loc, name, "use,prop", `property ${name}`, `#${name}`, false,
                maybeNesting);
    this.target(loc, name, "assign", name, `#${name}`);
    if (extra) {
      this.source(loc, name, "use,prop", `property ${extraPretty}`, extra,
                  false, maybeNesting);
      this.target(loc, name, "assign", extraPretty, extra);
    }
  },

  defVar(name, loc, maybeNesting) {
    if (!nameValid(name)) {
      return;
    }
    if (this.isToplevel()) {
      this.defProp(name, loc, undefined, undefined, maybeNesting);
      return;
    }
    let sym = new SymbolTable.Symbol(name, loc);
    this.symbols.put(name, sym);

    this.source(loc, name, "deflocal,variable", `variable ${name}`, sym.id, true,
                maybeNesting);
  },

  findSymbol(name) {
    let sym = this.symbols.get(name);
    if (!sym) {
      for (let i = this.symbolTableStack.length - 1; i >= 0; i--) {
        sym = this.symbolTableStack[i].get(name);
        if (sym) {
          break;
        }
      }
    }
    return sym;
  },

  useVar(name, loc) {
    if (!nameValid(name)) {
      return;
    }
    let sym = this.findSymbol(name);
    if (!sym) {
      this.useProp(name, loc);
    } else if (!sym.skip) {
      this.source(loc, name, "uselocal,variable", `variable ${name}`, sym.id, true);
    }
  },

  assignVar(name, loc) {
    if (!nameValid(name)) {
      return;
    }
    let sym = this.findSymbol(name);
    if (!sym) {
      this.assignProp(name, loc);
    } else if (!sym.skip) {
      this.source(loc, name, "uselocal,variable", `variable ${name}`, sym.id, true);
    }
  },

  functionDecl(f) {
    for (let i = 0; i < f.params.length; i++) {
      this.pattern(f.params[i]);
      this.maybeExpression(f.defaults[i]);
    }
    if (f.rest) {
      this.defVar(f.rest.name, f.rest.loc);
    }
    if (f.body.type == "BlockStatement") {
      this.statement(f.body);
    } else {
      this.expression(f.body);
    }
  },

  statement(stmt) {
    switch (stmt.type) {
    case "EmptyStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "DebuggerStatement":
      break;

    case "BlockStatement":
      this.scoped(null, () => {
        for (let stmt2 of stmt.body) {
          this.statement(stmt2);
        }
      });
      break;

    case "ExpressionStatement":
      this.expression(stmt.expression);
      break;

    case "IfStatement":
      this.expression(stmt.test);
      this.statement(stmt.consequent);
      this.maybeStatement(stmt.alternate);
      break;

    case "LabeledStatement":
      this.statement(stmt.body);
      break;

    case "WithStatement":
      this.expression(stmt.object);
      this.statement(stmt.body);
      break;

    case "SwitchStatement":
      this.expression(stmt.discriminant);
      for (let scase of stmt.cases) {
        this.switchCase(scase);
      }
      break;

    case "ReturnStatement":
      this.maybeExpression(stmt.argument);
      break;

    case "ThrowStatement":
      this.expression(stmt.argument);
      break;

    case "TryStatement":
      this.statement(stmt.block);
      if (stmt.handler) {
        this.catchClause(stmt.handler);
      }
      this.maybeStatement(stmt.finalizer);
      break;

    case "WhileStatement":
      this.expression(stmt.test);
      this.statement(stmt.body);
      break;

    case "DoWhileStatement":
      this.statement(stmt.body);
      this.expression(stmt.test);
      break;

    case "ForStatement":
      this.scoped(null, () => {
        if (stmt.init && stmt.init.type == "VariableDeclaration") {
          this.variableDeclaration(stmt.init);
        } else if (stmt.init) {
          this.expression(stmt.init);
        }
        this.maybeExpression(stmt.test);
        this.maybeExpression(stmt.update);
        this.statement(stmt.body);
      });
      break;

    case "ForInStatement":
    case "ForOfStatement":
      this.scoped(null, () => {
        if (stmt.left && stmt.left.type == "VariableDeclaration") {
          this.variableDeclaration(stmt.left);
        } else {
          this.expression(stmt.left);
        }
        this.expression(stmt.right);
        this.statement(stmt.body);
      });
      break;

    case "LetStatement":
      this.scoped(null, () => {
        for (let decl of stmt.head) {
          this.variableDeclarator(decl);
        }
        this.statement(stmt.body);
      });
      break;

    case "FunctionDeclaration":
      this.defVar(stmt.id.name, stmt.loc, stmt.body);
      this.scoped(stmt.id.name, () => {
        this.functionDecl(stmt);
      });
      break;

    case "VariableDeclaration":
      this.variableDeclaration(stmt);
      break;

    //
    case "ClassStatement":
      this.defVar(stmt.id.name, stmt.id.loc,
                  this.deriveLocationFromOuterNodeAndIdNode(stmt, stmt.id));
      this.scoped(stmt.id.name, () => {
        let oldClass = this.className;
        this.className = stmt.id.name;
        if (stmt.superClass) {
          this.expression(stmt.superClass);
        }
        for (let stmt2 of stmt.body) {
          this.statement(stmt2);
        }
        this.className = oldClass;
      });
      break;

    case "ClassMethod": {
      let name = null;
      if (stmt.name.type == "Identifier") {
        name = stmt.name.name;
        this.defProp(
          stmt.name.name, stmt.name.loc,
          `${this.className}#${name}`, `${this.className}.${name}`,
          stmt.body);
      }

      this.scoped(name, () => {
        if (stmt.body.type == "FunctionExpression") {
          // Don't want to find the name twice.
          this.functionDecl(stmt.body);
        } else {
          this.expression(stmt.body);
        }
      });
      break;
    }

    // Class fields: https://github.com/tc39/proposal-class-fields
    // These are defined to have Object.defineProperty semantics.  The spec also
    // introduces private fields and these are partially supported, but
    // bug 1559269 disabled TokenStream support for them, so we don't support
    // them for now.
    case "ClassField": {
      let name = null;
      // name could be a computed name!
      if (stmt.name.type == "Identifier") {
        name = stmt.name.name;
        this.defProp(
          stmt.name.name, stmt.name.loc,
          `${this.className}#${name}`, `${this.className}.${name}`);
      }
      this.contextStack.push(name);
      if (stmt.init) {
        this.expression(stmt.init);
      }
      this.contextStack.pop();
      break;
    }

    case "StaticClassBlock": {
      this.statement(stmt.body);
      break;
    }

    default:
      throw "Unexpected statement: " + stmt.type + " " + JSON.stringify(stmt);
      break;
    }
  },

  variableDeclaration(decl) {
    for (let d of decl.declarations) {
      this.variableDeclarator(d);
    }
  },

  variableDeclarator(decl) {
    this.pattern(decl.id);

    let oldNameForThis = this.nameForThis;
    if (decl.id.type == "Identifier" && decl.init) {
      if (decl.init.type == "ObjectExpression") {
        this.nameForThis = decl.id.name;
      } else {
        // Handle Object.freeze({...})
      }
    }
    this.contextStack.push(this.nameForThis);
    this.maybeExpression(decl.init);
    this.contextStack.pop();
    this.nameForThis = oldNameForThis;
  },

  maybeStatement(stmt) {
    if (stmt) {
      this.statement(stmt);
    }
  },

  maybeExpression(expr) {
    if (expr) {
      this.expression(expr);
    }
  },

  switchCase(scase) {
    if (scase.test) {
      this.expression(scase.test);
    }
    for (let stmt of scase.consequent) {
      this.statement(stmt);
    }
  },

  catchClause(clause) {
    if (clause.param) {
      this.pattern(clause.param);
    }
    if (clause.guard) {
      this.expression(clause.guard);
    }
    this.statement(clause.body);
  },

  expression(expr) {
    if (!expr) print(Error().stack);

    switch (expr.type) {
    case "Identifier":
      this.useVar(expr.name, expr.loc);
      break;

    case "Literal":
      break;

    case "Super":
      break;

    case "TemplateLiteral":
      for (let elt of expr.elements) {
        this.expression(elt);
      }
      break;

    case "TaggedTemplate":
      // Do something eventually!
      break;

    case "ThisExpression":
      // Do something eventually!
      break;

    case "ArrayExpression":
    case "ArrayPattern":
      for (let elt of expr.elements) {
        this.maybeExpression(elt);
      }
      break;

    case "ObjectExpression":
    case "ObjectPattern":
      for (let prop of expr.properties) {
        let name;

        if (prop.key) {
          let loc;
          if (prop.key.type == "Identifier") {
            name = prop.key.name;
            loc = prop.key.loc;
          } else if (prop.key.type == "Literal" && typeof(prop.key.value) == "string") {
            name = prop.key.value;
            loc = prop.key.loc;
            loc.start.column++;
          }
          let extra = null;
          let extraPretty = null;
          if (this.nameForThis) {
            extra = `${this.nameForThis}#${name}`;
            extraPretty = `${this.nameForThis}.${name}`;
          }
          if (name) {
            this.defProp(name, prop.key.loc, extra, extraPretty, prop.value);
          }
        }

        this.contextStack.push(name);
        if (prop.value) {
          this.expression(prop.value);
        }
        this.contextStack.pop();
      }
      break;

    case "FunctionExpression":
    case "ArrowFunctionExpression":
      // In theory this could declare a variable that can be used in
      // the function. But most of the time, it appears on class
      // methods that don't actually define such a variable. This is
      // probably a SpiderMonkey bug. We just don't do anything here
      // to be correct in the common case.
      //let name = expr.id ? expr.id.name : "";
      let name = null;
      this.scoped(name, () => {
        if (this.className && name == this.className) {
          // SPIDERMONKEY HACK: Fixes a bug where constructors get the
          // name of their class instead of "constructor".
          name = "constructor";
        }

        if (expr.type == "FunctionExpression" && name) {
          this.defVar(name, expr.loc);
        }

        this.functionDecl(expr);
      });
      break;

    case "SequenceExpression":
      for (let elt of expr.expressions) {
        this.expression(elt);
      }
      break;

    case "UnaryExpression":
    case "UpdateExpression":
      this.expression(expr.argument);
      break;

    case "AssignmentExpression":
      if (expr.left.type == "Identifier") {
        this.assignVar(expr.left.name, expr.left.loc);
      } else if (expr.left.type == "MemberExpression" && !expr.left.computed) {
        this.expression(expr.left.object);

        let extra = null;
        let extraPretty = null;
        if (expr.left.object.type == "ThisExpression" && this.nameForThis) {
          extra = `${this.nameForThis}#${expr.left.property.name}`;
          extraPretty = `${this.nameForThis}.${expr.left.property.name}`;
        } else if (expr.left.object.type == "Identifier") {
          extra = `${expr.left.object.name}#${expr.left.property.name}`;
          extraPretty = `${expr.left.object.name}.${expr.left.property.name}`;
        }
        this.assignProp(expr.left.property.name, memberPropLoc(expr.left), extra, extraPretty,
                        expr.right.loc);
      } else {
        this.expression(expr.left);
      }

      let oldNameForThis = this.nameForThis;
      if (expr.left.type == "MemberExpression" &&
          !expr.left.computed)
      {
        if (expr.left.property.name == "prototype" &&
            expr.left.object.type == "Identifier")
        {
          this.nameForThis = expr.left.object.name;
        }
        if (expr.left.object.type == "ThisExpression") {
          this.nameForThis = expr.left.property.name;
        }
      }
      this.contextStack.push(this.nameForThis);
      this.expression(expr.right);
      this.contextStack.pop();
      this.nameForThis = oldNameForThis;
      break;

    case "BinaryExpression":
    case "LogicalExpression":
      this.expression(expr.left);
      this.expression(expr.right);
      break;

    case "ConditionalExpression":
      this.expression(expr.test);
      this.expression(expr.consequent);
      this.expression(expr.alternate);
      break;

    case "NewExpression":
    case "CallExpression":
    case "OptionalCallExpression":
      this.expression(expr.callee);
      for (let arg of expr.arguments) {
        this.expression(arg);
      }
      break;

    case "MemberExpression":
    case "OptionalMemberExpression":
      this.expression(expr.object);
      if (expr.computed) {
        this.expression(expr.property);
      } else {
        let extra = null;
        let extraPretty = null;
        if (expr.object.type == "ThisExpression" && this.nameForThis) {
          extra = `${this.nameForThis}#${expr.property.name}`;
          extraPretty = `${this.nameForThis}.${expr.property.name}`;
        } else if (expr.object.type == "Identifier") {
          extra = `${expr.object.name}#${expr.property.name}`;
          extraPretty = `${expr.object.name}.${expr.property.name}`;
        }

        this.useProp(expr.property.name, memberPropLoc(expr), extra, extraPretty);
      }
      break;

    case "YieldExpression":
      this.maybeExpression(expr.argument);
      break;

    case "SpreadExpression":
      this.expression(expr.expression);
      break;

    case "ComprehensionExpression":
    case "GeneratorExpression":
      this.scoped(null, () => {
        let before = locBefore(expr.body.loc, expr.blocks[0].loc);
        if (before) {
          this.expression(expr.body);
        }
        for (let block of expr.blocks) {
          this.comprehensionBlock(block);
        }
        this.maybeExpression(expr.filter);
        if (!before) {
          this.expression(expr.body);
        }
      });
      break;

    case "ClassExpression":
      this.scoped(null, () => {
        if (expr.superClass) {
          this.expression(expr.superClass);
        }
        for (let stmt2 of expr.body) {
          this.statement(stmt2);
        }
      });
      break;

    case "OptionalExpression":
    case "DeleteOptionalExpression":
      // a?.b is an optional expression that is equivalent to a && a.b.
      // expr.expression is an OptionalMemberExpression or OptionalCallExpression
      this.expression(expr.expression);
      break;

    case "MetaProperty": // Not sure what this is!
    case "CallImport": // dynamic import statement, see e.g. https://hg.mozilla.org/mozilla-central/file/4df1ba9c741f/testing/web-platform/tests/html/semantics/scripting-1/the-script-element/module/dynamic-import/propagate-nonce-external.js#l3
      break;

    default:
      printErr(Error().stack);
      throw `Invalid expression ${expr.type}: ${JSON.stringify(expr)}`;
      break;
    }
  },

  comprehensionBlock(block) {
    switch (block.type) {
    case "ComprehensionBlock":
      this.pattern(block.left);
      this.expression(block.right);
      break;

    case "ComprehensionIf":
      this.expression(block.test);
      break;
    }
  },

  pattern(pat) {
    if (!pat) {
      print(Error().stack);
    }

    switch (pat.type) {
    case "Identifier":
      this.defVar(pat.name, pat.loc);
      break;

    case "ObjectPattern":
      for (let prop of pat.properties) {
        if (prop.type == "Property") {
          this.pattern(prop.value);
        } else if (prop.type == "SpreadExpression") {
          this.pattern(prop.expression);
        } else {
          throw `Unexpected prop ${JSON.stringify(prop)} in ObjectPattern`;
        }
      }
      break;

    case "ArrayPattern":
      for (let e of pat.elements) {
        if (e) {
          this.pattern(e);
        }
      }
      break;

    case "SpreadExpression":
      this.pattern(pat.expression);
      break;

    case "AssignmentExpression":
      this.pattern(pat.left);
      this.expression(pat.right);
      break;

    default:
      throw `Unexpected pattern: ${pat.type} ${JSON.stringify(pat)}`;
      break;
    }
  },
};

function preprocess(filename, comment)
{
  let text;
  try {
    text = snarf(filename);
  } catch (e) {
    text = "";
  }

  let substitution = false;
  let lines = text.split("\n");
  let preprocessedLines = [];
  let branches = [true];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (substitution) {
      line = line.replace(/@(\w+)@/, "''");
    }
    let tline = line.trim();
    if (tline.startsWith("#ifdef") || tline.startsWith("#ifndef") || tline.startsWith("#if ")) {
      preprocessedLines.push(comment(tline));
      branches.push(branches[branches.length-1]);
    } else if (tline.startsWith("#else") ||
               tline.startsWith("#elif") ||
               tline.startsWith("#elifdef") ||
               tline.startsWith("#elifndef")) {
      preprocessedLines.push(comment(tline));
      branches.pop();
      branches.push(false);
    } else if (tline.startsWith("#endif")) {
      preprocessedLines.push(comment(tline));
      branches.pop();
    } else if (!branches[branches.length-1]) {
      preprocessedLines.push(comment(tline));
    } else if (tline.startsWith("#include")) {
      /*
      let match = tline.match(/#include "?([A-Za-z0-9_.-]+)"?/);
      if (!match) {
        throw new Error(`Invalid include directive: ${filename}:${i+1}`);
      }
      let incfile = match[1];
      preprocessedLines.push(`PREPROCESSOR_INCLUDE("${incfile}");`);
      */
      preprocessedLines.push(comment(tline));
    } else if (tline.startsWith("#filter substitution")) {
      preprocessedLines.push(comment(tline));
      substitution = true;
    } else if (tline.startsWith("#filter")) {
      preprocessedLines.push(comment(tline));
    } else if (tline.startsWith("#expand")) {
      preprocessedLines.push(line.substring(String("#expand ").length));
    } else if (tline.startsWith("#")) {
      preprocessedLines.push(comment(tline));
    } else {
      preprocessedLines.push(line);
    }
  }

  return preprocessedLines.join("\n");
}

function analyzeJS(filename)
{
  let text = preprocess(filename, line => "// " + line);

  let ast = Analyzer.parse(text, filename, 1);
  if (ast) {
    Analyzer.program(ast);
  }
}

function replaceEntities(text)
{
  var table = {
    "&amp;&amp;": "&&        ",
    "&amp;": "&    ",
    "&lt;": "<   ",
    "&gt;": ">   ",
  };

  for (let ent in table) {
    let re = RegExp(ent, "gi");
    text = text.replace(re, table[ent]);
  }

  return text.replace(/&[a-zA-Z0-9.]+;/g, match => {
    return "'" + match.slice(1, match.length - 2) + "'";
  });
}

class XMLParser {
  constructor(filename, lines, parser) {
    this.filename = filename;
    this.lines = lines;
    this.stack = [];
    this.curText = "";
    this.curAttrs = {};
    this.parser = parser;
  }

  onopentag(tag) {
    tag.line = this.parser.line;
    tag.column = this.parser.column;
    tag.attrs = this.curAttrs;
    this.curAttrs = {};
    this.stack.push(tag);
    this.curText = "";
  }

  onclosetag(tagName) {
    let tag = this.stack[this.stack.length - 1];

    this.ontag(tagName, tag);

    this.stack.pop();
  }

  ontag(tagName, tag) {
  }

  ontext(text) {
    this.curText += text;
  }

  oncdata(text) {
    this.curText += text;
  }

  onattribute(attr) {
    attr.line = this.parser.line;
    attr.column = this.parser.column;
    this.curAttrs[attr.name] = attr;
  }

  backup(line, column, text) {
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] == "\n") {
        line--;
        column = this.lines[line].length;
      } else {
        column--;
      }
    }
    return [line, column];
  }
}

class XBLParser extends XMLParser {
  ontag(tagName, tag) {
    switch (tagName) {
    case "FIELD":
      this.onfield(tag);
      break;
    case "PROPERTY":
      this.onproperty(tag);
      break;
    case "GETTER":
      this.ongetter(tag);
      break;
    case "SETTER":
      this.onsetter(tag);
      break;
    case "METHOD":
      this.onmethod(tag);
      break;
    case "PARAMETER":
      this.onparameter(tag);
      break;
    case "BODY":
      this.onbody(tag);
      break;
    case "CONSTRUCTOR":
    case "DESTRUCTOR":
      this.onstructor(tag);
      break;
    case "HANDLER":
      this.onhandler(tag);
      break;
    }
  }

  onfield(tag) {
    if (!tag.attrs.NAME) {
      return;
    }

    let {line, column} = tag.attrs.NAME;
    let name = tag.attrs.NAME.value;

    [line, column] = this.backup(line, column, name + "\"");

    let locStr = `${line + 1}:${column}-${column + name.length}`;
    Analyzer.source(locStr, name, "def,prop", `property ${name}`, `#${name}`,
                    false);
    Analyzer.target(locStr, name, "def", name, `#${name}`);

    let spaces = Array(tag.column).join(" ");
    let text = spaces + this.curText;

    let ast = Analyzer.parse(text, this.filename, tag.line + 1);
    if (ast) {
      Analyzer.program(ast);
    }
  }

  onproperty(tag) {
    let name = null;
    if (tag.attrs.NAME) {
      let {line, column} = tag.attrs.NAME;
      name = tag.attrs.NAME.value;

      [line, column] = this.backup(line, column, name + "\"");

      let locStr = `${line + 1}:${column}-${column + name.length}`;
      Analyzer.source(locStr, name, "def,prop", `property ${name}`, `#${name}`,
                      false);
      Analyzer.target(locStr, name, "def", name, `#${name}`);
    }

    let line, column;
    for (let prop in tag.attrs) {
      if (prop != "ONGET" && prop != "ONSET") {
        continue;
      }

      let text = tag.attrs[prop].value;
      line = tag.attrs[prop].line;
      column = tag.attrs[prop].column;

      [line, column] = this.backup(line, column, text + "\"");

      let spaces = Array(column + 1).join(" ");
      text = `(function (val) {\n${spaces}${text}})`;

      let ast = Analyzer.parse(text, this.filename, line);
      if (ast) {
        Analyzer.scoped(name, () => Analyzer.dummyProgram(ast, [{name: "val", skip: true}]));
      }
    }

    for (let prop in tag) {
      if (prop != "getter" && prop != "setter") {
        continue;
      }

      let text = tag[prop].text;
      line = tag[prop].line;
      column = tag[prop].column;

      let spaces = Array(column + 1).join(" ");
      text = `(function (val) {\n${spaces}${text}})`;

      let ast = Analyzer.parse(text, this.filename, line);
      if (ast) {
        Analyzer.scoped(name, () => Analyzer.dummyProgram(ast, [{name: "val", skip: true}]));
      }
    }
  }

  ongetter(tag) {
    tag.text = this.curText;
    let parentTag = this.stack[this.stack.length - 2];
    if (parentTag) {
      parentTag.getter = tag;
    }
  }

  onsetter(tag) {
    tag.text = this.curText;
    let parentTag = this.stack[this.stack.length - 2];
    if (parentTag) {
      parentTag.setter = tag;
    }
  }

  onparameter(tag) {
    let parentTag = this.stack[this.stack.length - 2];
    if (parentTag) {
      if (!parentTag.params) {
        parentTag.params = [];
      }
      parentTag.params.push(tag);
    }
  }

  onbody(tag) {
    tag.text = this.curText;
    let parentTag = this.stack[this.stack.length - 2];
    if (parentTag) {
      parentTag.body = tag;
    }
  }

  onstructor(tag) {
    let text = this.curText;
    let {line, column} = tag;

    let spaces = Array(column + 1).join(" ");
    text = `(function () {\n${spaces}${text}})`;

    let ast = Analyzer.parse(text, this.filename, line);
    if (ast) {
      Analyzer.scoped(null, () => Analyzer.dummyProgram(ast, []));
    }
  }

  onhandler(tag) {
    let text = this.curText;
    let {line, column} = tag;

    let spaces = Array(column + 1).join(" ");
    text = `(function () {\n${spaces}${text}})`;

    let ast = Analyzer.parse(text, this.filename, line);
    if (ast) {
      Analyzer.scoped(null, () => Analyzer.dummyProgram(ast, []));
    }
  }

  onmethod(tag) {
    if (!tag.attrs.NAME) {
      return;
    }

    let {line, column} = tag.attrs.NAME;
    let name = tag.attrs.NAME.value;

    [line, column] = this.backup(line, column, name + "\"");

    let locStr = `${line + 1}:${column}-${column + name.length}`;
    Analyzer.source(locStr, name, "def,prop", `property ${name}`, `#${name}`,
                    false);
    Analyzer.target(locStr, name, "def", name, `#${name}`);

    Analyzer.enter(name);

    let params = tag.params || [];
    for (let p of params) {
      let text = p.attrs.NAME.value;
      line = p.attrs.NAME.line;
      column = p.attrs.NAME.column;
      [line, column] = this.backup(line, column, text + "\"");

      Analyzer.defVar(text, {start: {line: line + 1, column}});
    }

    if (tag.body) {
      let text = tag.body.text;
      line = tag.body.line;
      column = tag.body.column;

      params = params.map(p => p.attrs.NAME.value);
      let paramsText = params.join(", ");

      let spaces = Array(column + 1).join(" ");
      text = `(function (${paramsText}) {\n${spaces}${text}})`;

      let ast = Analyzer.parse(text, this.filename, line);
      if (ast) {
        Analyzer.dummyProgram(ast, []);
      }
    }

    Analyzer.exit();
  }
}

function analyzeXBL(filename)
{
  let text = replaceEntities(preprocess(filename, line => `<!--${line}-->`));

  let lines = text.split("\n");

  let parser = sax.parser(false, {trim: false, normalize: false, xmlns: true, position: true});

  let xbl = new XBLParser(filename, lines, parser);
  for (let prop of ["onopentag", "onclosetag", "onattribute", "ontext", "oncdata"]) {
    let x = prop;
    parser[x] = (...args) => { xbl[x](...args); };
  }

  parser.write(text);
  parser.close();
}

class XULParser extends XMLParser {
  ontag(tagName, tag) {
    switch (tagName) {
    case "SCRIPT":
      this.onscript(tag);
      break;
    }

    let line, column;
    for (let prop in tag.attrs) {
      if (!prop.startsWith("ON")) {
        continue;
      }

      let text = tag.attrs[prop].value;
      line = tag.attrs[prop].line;
      column = tag.attrs[prop].column;

      [line, column] = this.backup(line, column, text + "\"");

      let spaces = Array(column + 1).join(" ");
      text = `(function (val) {\n${spaces}${text}})`;

      let ast = Analyzer.parse(text, this.filename, line);
      if (ast) {
        Analyzer.dummyProgram(ast, [{name: "event", skip: true}]);
      }
    }
  }

  onscript(tag) {
    let text = this.curText;
    let {line, column} = tag;

    let spaces = Array(column + 1).join(" ");
    text = `(function () {\n${spaces}${text}})`;

    let ast = Analyzer.parse(text, this.filename, line);
    if (ast) {
      Analyzer.scoped(null, () => Analyzer.dummyProgram(ast, []));
    }
  }
}

function analyzeXUL(filename)
{
  let text = replaceEntities(preprocess(filename, line => `<!--${line}-->`));

  if (filename.endsWith(".inc")) {
    text = "<root>" + text + "</root>";
  }

  let lines = text.split("\n");

  let parser = sax.parser(false, {trim: false, normalize: false, xmlns: true, position: true, noscript: true});

  let xul = new XULParser(filename, lines, parser);
  for (let prop of ["onopentag", "onclosetag", "onattribute", "ontext", "oncdata"]) {
    let x = prop;
    parser[x] = (...args) => { xul[x](...args); };
  }

  parser.write(text);
  parser.close();
}

function analyzeFile(filename)
{
  if (filename.endsWith(".xml")) {
    analyzeXBL(filename);
  } else if (filename.endsWith(".xul") || filename.endsWith(".inc")) {
    analyzeXUL(filename);
  } else {
    analyzeJS(filename);
  }
}

fileIndex = scriptArgs[0];
mozSearchRoot = scriptArgs[1];
localFile = scriptArgs[2];

run(mozSearchRoot + "/sax/sax.js");

analyzeFile(localFile);
