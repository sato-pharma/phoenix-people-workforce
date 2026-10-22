import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

import org.apache.catalina.valves.rewrite.Resolver;
import org.apache.catalina.valves.rewrite.RewriteCond;
import org.apache.catalina.valves.rewrite.RewriteRule;
import org.apache.catalina.valves.rewrite.RewriteValve;

/**
 * Build-time check of rewrite.config, run with Tomcat's OWN parser and engine against the image's own jars.
 *
 * Why at build: a line Tomcat cannot parse throws from RewriteValve.startInternal, the Host fails to
 * start, and the server serves nothing — while Railway's deploy check, which watches the container,
 * reports green (the Dockerfile's logging note records the same trap). Failing the BUILD instead
 * leaves the running deployment in place.
 *
 * Step one is what the valve does at start: RewriteValve.parse(line) for every line, conditions
 * attached to the rule that follows them, then RewriteRule.parse(maps), which compiles each pattern and
 * its conditions. It refuses anything that is not a rule, a condition or a comment, a rule that does
 * not refuse with [F], a condition left dangling at the end, and a file whose rule count is not the one
 * passed in.
 *
 * Step two is what the valve does per request: every rule's evaluate() in order, refusing on the first
 * [F] rule that matches, over each line of rewrite-cases.txt. 🔴 That step exists because the host split
 * is an ALLOWLIST: a rule that parses perfectly but leaves out one tablet path takes the fleet dark at
 * its next check-in, with the server looking healthy. A wrong case here fails the build instead.
 */
public class RewriteCheck {

  /** The one thing the rules read besides the path: the host, as Tomcat's ResolverImpl gives it. */
  static final class CaseResolver extends Resolver {
    private final String host;

    CaseResolver(String host) {
      this.host = host;
    }

    @Override
    public String resolve(String key) {
      if ("HTTP_HOST".equals(key)) return host;
      throw new IllegalStateException("rewrite.config reads %{" + key + "}, which this check does not model — add it here first");
    }

    @Override
    public String resolveSsl(String key) {
      throw new IllegalStateException("rewrite.config reads %{SSL:" + key + "}, which this check does not model");
    }

    @Override
    public String resolveHttp(String key) {
      throw new IllegalStateException("rewrite.config reads %{HTTP:" + key + "}, which this check does not model");
    }

    @Override
    public boolean resolveResource(int type, String name) {
      throw new IllegalStateException("rewrite.config tests a resource, which this check does not model");
    }

    @Override
    public Charset getUriCharset() {
      return StandardCharsets.UTF_8;
    }
  }

  public static void main(String[] args) throws Exception {
    List<String> lines = Files.readAllLines(Paths.get(args[0]), StandardCharsets.UTF_8);
    int expected = Integer.parseInt(args[1]);
    List<RewriteRule> rules = new ArrayList<>();
    List<RewriteCond> pending = new ArrayList<>();
    for (String line : lines) {
      Object parsed = RewriteValve.parse(line);
      if (parsed == null) continue;
      if (parsed instanceof RewriteCond) {
        pending.add((RewriteCond) parsed);
        continue;
      }
      if (!(parsed instanceof RewriteRule)) {
        throw new IllegalStateException("only RewriteRule and RewriteCond lines belong in rewrite.config: " + line);
      }
      RewriteRule rule = (RewriteRule) parsed;
      for (RewriteCond cond : pending) rule.addCondition(cond);
      pending.clear();
      rule.parse(new HashMap<>());
      if (!rule.isForbidden()) {
        throw new IllegalStateException("every rule here refuses with [F]: " + line);
      }
      rules.add(rule);
    }
    if (!pending.isEmpty()) {
      throw new IllegalStateException("rewrite.config ends with a RewriteCond that no rule follows");
    }
    if (rules.size() != expected) {
      throw new IllegalStateException("rewrite.config holds " + rules.size() + " rules, expected " + expected);
    }

    int cases = 0;
    List<String> wrong = new ArrayList<>();
    for (String line : Files.readAllLines(Paths.get(args[2]), StandardCharsets.UTF_8)) {
      String trimmed = line.trim();
      if (trimmed.isEmpty() || trimmed.startsWith("#")) continue;
      String[] parts = trimmed.split("\\s+");
      if (parts.length != 3 || !(parts[0].equals("allow") || parts[0].equals("refuse"))) {
        throw new IllegalStateException("a case is <allow|refuse> <host> <path>: " + line);
      }
      boolean refused = false;
      CaseResolver resolver = new CaseResolver(parts[1]);
      for (RewriteRule rule : rules) {
        if (rule.evaluate(parts[2], resolver) != null) {
          refused = true;
          break;
        }
      }
      if (refused != parts[0].equals("refuse")) {
        wrong.add((refused ? "REFUSED " : "ALLOWED ") + parts[1] + " " + parts[2] + " (expected " + parts[0] + ")");
      }
      cases++;
    }
    if (!wrong.isEmpty()) {
      throw new IllegalStateException("rewrite.config does not do what rewrite-cases.txt says:\n  " + String.join("\n  ", wrong));
    }
    if (cases == 0) {
      throw new IllegalStateException("rewrite-cases.txt holds no cases — a check over nothing proves nothing");
    }
    System.out.println("RewriteCheck: rewrite.config parses with Tomcat's own parser — " + rules.size()
        + " refusal rules, and Tomcat's own engine agrees with all " + cases + " cases");
  }
}
