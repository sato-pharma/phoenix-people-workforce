package com.hmdm.plugins.phoenix.security;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The smallest JSON reader the Access check needs: objects, arrays, strings, numbers, booleans, null.
 *
 * 🔴 WHY NOT JACKSON, WHICH THE SERVER ALREADY USES. This add-on compiles only against jars it has read
 * out of the WAR (pom.xml says why: a provided API at the wrong version fails at runtime, once, inside
 * a hook nobody watches). jackson-databind's version in the WAR was never read, and the Access gate is
 * a filter Guice builds at startup — a missing class there fails the whole plugin, console and tablet
 * actions with it. Three small JSON documents (a JWT header, its claims, Cloudflare's key list) do not
 * justify that risk.
 */
final class MiniJson {

    private final String text;
    private int pos;

    private MiniJson(String text) {
        this.text = text;
    }

    static Object parse(String text) {
        MiniJson reader = new MiniJson(text);
        reader.space();
        Object value = reader.value();
        reader.space();
        if (reader.pos != text.length()) throw new IllegalArgumentException("trailing characters after JSON");
        return value;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(String text) {
        Object value = parse(text);
        if (!(value instanceof Map)) throw new IllegalArgumentException("not a JSON object");
        return (Map<String, Object>) value;
    }

    private Object value() {
        if (pos >= text.length()) throw new IllegalArgumentException("unexpected end of JSON");
        char c = text.charAt(pos);
        if (c == '{') return obj();
        if (c == '[') return arr();
        if (c == '"') return str();
        if (text.startsWith("true", pos)) { pos += 4; return Boolean.TRUE; }
        if (text.startsWith("false", pos)) { pos += 5; return Boolean.FALSE; }
        if (text.startsWith("null", pos)) { pos += 4; return null; }
        return num();
    }

    private Map<String, Object> obj() {
        Map<String, Object> out = new LinkedHashMap<>();
        pos++;
        space();
        if (peek() == '}') { pos++; return out; }
        while (true) {
            space();
            if (peek() != '"') throw new IllegalArgumentException("expected a key");
            String key = str();
            space();
            expect(':');
            space();
            out.put(key, value());
            space();
            char c = next();
            if (c == '}') return out;
            if (c != ',') throw new IllegalArgumentException("expected , or }");
        }
    }

    private List<Object> arr() {
        List<Object> out = new ArrayList<>();
        pos++;
        space();
        if (peek() == ']') { pos++; return out; }
        while (true) {
            space();
            out.add(value());
            space();
            char c = next();
            if (c == ']') return out;
            if (c != ',') throw new IllegalArgumentException("expected , or ]");
        }
    }

    private String str() {
        expect('"');
        StringBuilder out = new StringBuilder();
        while (true) {
            char c = next();
            if (c == '"') return out.toString();
            if (c != '\\') { out.append(c); continue; }
            char e = next();
            switch (e) {
                case '"': out.append('"'); break;
                case '\\': out.append('\\'); break;
                case '/': out.append('/'); break;
                case 'b': out.append('\b'); break;
                case 'f': out.append('\f'); break;
                case 'n': out.append('\n'); break;
                case 'r': out.append('\r'); break;
                case 't': out.append('\t'); break;
                case 'u':
                    if (pos + 4 > text.length()) throw new IllegalArgumentException("short \\u escape");
                    out.append((char) Integer.parseInt(text.substring(pos, pos + 4), 16));
                    pos += 4;
                    break;
                default: throw new IllegalArgumentException("bad escape");
            }
        }
    }

    private Double num() {
        int start = pos;
        while (pos < text.length() && "+-0123456789.eE".indexOf(text.charAt(pos)) >= 0) pos++;
        if (start == pos) throw new IllegalArgumentException("unexpected character in JSON");
        return Double.valueOf(text.substring(start, pos));
    }

    private void space() {
        while (pos < text.length() && Character.isWhitespace(text.charAt(pos))) pos++;
    }

    private char peek() {
        if (pos >= text.length()) throw new IllegalArgumentException("unexpected end of JSON");
        return text.charAt(pos);
    }

    private char next() {
        char c = peek();
        pos++;
        return c;
    }

    private void expect(char c) {
        if (next() != c) throw new IllegalArgumentException("expected " + c);
    }
}
