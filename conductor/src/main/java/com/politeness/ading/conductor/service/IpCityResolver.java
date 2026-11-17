package com.politeness.ading.conductor.service;

import java.io.InputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import lombok.extern.slf4j.Slf4j;
import net.dreamlu.mica.ip2region.xdb.Searcher;
import net.dreamlu.mica.ip2region.xdb.Version;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.stereotype.Component;

/**
 * Offline city lookup by IP (ip2region database, bundled in the jar via the mica-ip2region dependency; no external service calls).
 *
 * City and region permission use the IPv4 or IPv6 database depending on the request IP. On first use it is extracted from the jar to a temp file and queried from that file afterwards.
 * mica's built-in auto-configuration loads both the IPv4 (11 MB) and IPv6 (37 MB) databases entirely into memory,
 * which isn't worth it for city lookup at terminal registration, so it is disabled in application.yml.
 * Result format: country|province|city|ISP|country code; unknown segments are 0.
 */
@Slf4j
@Component
public class IpCityResolver implements DisposableBean {

    static final String DATABASE = "ip2region/ip2region_v4.xdb";
    /** Placeholder values in the database for reserved and private ranges; not cities */
    private static final java.util.Set<String> RESERVED = java.util.Set.of("Reserved", "内网IP", "保留地址");

    private Searcher searcher;
    private Path file;
    private Searcher ipv6Searcher;
    private Path ipv6File;

    /** City; for municipalities etc. that only have a province level, use the province; null for private or not found */
    public synchronized String city(String ip) {
        try {
            // Accept IP literals only: getByName does a DNS lookup for hostnames, and the backend must not resolve domains because of a request field
            InetAddress address = InetAddress.ofLiteral(ip.trim());
            if (address.isAnyLocalAddress() || address.isMulticastAddress() || address.isLoopbackAddress()
                    || address.isSiteLocalAddress() || address.isLinkLocalAddress()) {
                return null;
            }
            Searcher database = address instanceof Inet4Address ? searcher() : ipv6Searcher();
            String[] parts = database.search(address.getHostAddress()).split("\\|", -1);
            for (int index : new int[] {2, 1}) {
                String value = parts.length > index ? parts[index].trim() : "";
                if (!value.isEmpty() && !"0".equals(value) && !RESERVED.contains(value)) return value;
            }
            return null;
        } catch (Exception error) {
            log.warn("Failed to resolve city by IP ip={}", ip, error);
            return null;
        }
    }

    /**
     * Whether this is a public IP in mainland China. The database also records Hong Kong, Macao and Taiwan as CN, so the province column must be checked too
     * (Hong Kong SAR / Macao SAR / Taiwan Province). Supports IPv4 / IPv6; private or not found counts as no.
     */
    public synchronized boolean isMainlandChina(String ip) {
        try {
            InetAddress address = InetAddress.ofLiteral(ip.trim());
            if (address.isLoopbackAddress()
                    || address.isSiteLocalAddress() || address.isLinkLocalAddress()) {
                return false;
            }
            Searcher database = address instanceof Inet4Address ? searcher() : ipv6Searcher();
            String[] parts = database.search(address.getHostAddress()).split("\\|", -1);
            String code = parts.length > 4 ? parts[4].trim() : "";
            String province = parts.length > 1 ? parts[1].trim() : "";
            return "CN".equals(code)
                    && !province.startsWith("香港") && !province.startsWith("澳门") && !province.startsWith("台湾");
        } catch (Exception error) {
            log.warn("Failed to determine region by IP ip={}", ip, error);
            return false;
        }
    }

    private Searcher searcher() throws Exception {
        if (searcher != null) return searcher;
        file = Files.createTempFile("ading-ip2region-", ".xdb");
        try (InputStream in = IpCityResolver.class.getClassLoader().getResourceAsStream(DATABASE)) {
            if (in == null) throw new IllegalStateException("Missing IP database " + DATABASE);
            Files.copy(in, file, StandardCopyOption.REPLACE_EXISTING);
        }
        searcher = Searcher.newWithFileOnly(Version.fromName("IPv4"), file.toFile());
        return searcher;
    }

    private Searcher ipv6Searcher() throws Exception {
        if (ipv6Searcher != null) return ipv6Searcher;
        ipv6File = Files.createTempFile("ading-ip2region-v6-", ".xdb");
        try (InputStream in = IpCityResolver.class.getClassLoader().getResourceAsStream("ip2region/ip2region_v6.xdb")) {
            if (in == null) throw new IllegalStateException("Missing IPv6 IP database");
            Files.copy(in, ipv6File, StandardCopyOption.REPLACE_EXISTING);
            ipv6Searcher = Searcher.newWithFileOnly(Version.fromName("IPv6"), ipv6File.toFile());
        } catch (Exception error) {
            Files.deleteIfExists(ipv6File);
            throw error;
        }
        return ipv6Searcher;
    }

    @Override
    public synchronized void destroy() throws Exception {
        if (searcher != null) searcher.close();
        if (file != null) Files.deleteIfExists(file);
        if (ipv6Searcher != null) ipv6Searcher.close();
        if (ipv6File != null) Files.deleteIfExists(ipv6File);
    }
}
