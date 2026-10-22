import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.List;

import org.apache.catalina.valves.rewrite.RewriteRule;
import org.apache.catalina.valves.rewrite.RewriteValve;

/**
 * Build-time check of rewrite.config, run with Tomcat's OWN parser against the image's own jars.
 *
 * Why at build: a line Tomcat cannot parse throws from RewriteValve.startInternal, the Host fails to
 * start, and the server serves nothing — while Railway's deploy check, which watches the container,
 * reports green (the Dockerfile's logging note records the same trap). Failing the BUILD instead
 * leaves the running deployment in place.
 *
 * It runs the same two steps the valve runs at start: RewriteValve.parse(line) for every line, then
 * RewriteRule.parse(maps), which compiles each pattern. It also refuses anything that is not a rule
 * or a comment, and a file whose rule count is not the one passed in.
 */
public class RewriteCheck {
  public static void main(String[] args) throws Exception {
    List<String> lines = Files.readAllLines(Paths.get(args[0]), StandardCharsets.UTF_8);
    int expected = Integer.parseInt(args[1]);
    int rules = 0;
    for (String line : lines) {
      Object parsed = RewriteValve.parse(line);
      if (parsed == null) continue;
      if (!(parsed instanceof RewriteRule)) {
        throw new IllegalStateException("only RewriteRule lines belong in rewrite.config: " + line);
      }
      RewriteRule rule = (RewriteRule) parsed;
      rule.parse(new HashMap<>());
      if (!rule.isForbidden()) {
        throw new IllegalStateException("every rule here refuses with [F]: " + line);
      }
      rules++;
    }
    if (rules != expected) {
      throw new IllegalStateException("rewrite.config holds " + rules + " rules, expected " + expected);
    }
    System.out.println("RewriteCheck: rewrite.config parses with Tomcat's own parser — " + rules + " refusal rules");
  }
}
