package com.politeness.ading.conductor.dal.mapper;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.politeness.ading.conductor.dal.entity.AppReleaseEntity;
import java.sql.Connection;
import java.sql.Statement;
import java.util.List;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSession;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Pre-release goes only to accounts tagged "pre-release gray" and their computers; everyone else sees nothing. The named list remains in effect. */
class AppReleaseVisibilityTest {

    private Connection keepAlive;
    private SqlSession session;
    private AppReleaseMapper mapper;

    @BeforeEach
    void setUp() throws Exception {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:release_visibility_" + System.nanoTime() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE");
        keepAlive = dataSource.getConnection();
        try (Statement st = keepAlive.createStatement()) {
            st.execute("""
                    CREATE TABLE app_releases (id BIGINT AUTO_INCREMENT PRIMARY KEY, platform VARCHAR(16), channel VARCHAR(20),
                      version VARCHAR(50), arch VARCHAR(16), rollout VARCHAR(16))""");
            st.execute("""
                    CREATE TABLE app_release_grays (id BIGINT AUTO_INCREMENT PRIMARY KEY, channel VARCHAR(20), version VARCHAR(50),
                      target_type VARCHAR(16), target_id VARCHAR(128))""");
            st.execute("CREATE TABLE user_tags (id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(64), tag VARCHAR(32))");
            st.execute("CREATE TABLE terminals (id BIGINT AUTO_INCREMENT PRIMARY KEY, owner VARCHAR(64), fingerprint VARCHAR(128), type VARCHAR(16))");
            st.execute("""
                    INSERT INTO app_releases (platform, channel, version, arch, rollout) VALUES
                      ('mac', 'pre', '1.0.0-pre', 'arm64', 'GRAY'),
                      ('mac', 'release', '0.9.0', 'arm64', 'ALL'),
                      ('mac', 'release', '1.0.0', 'arm64', 'GRAY')""");
            st.execute("INSERT INTO user_tags (user_id, tag) VALUES ('u_gray', 'PRE_GRAY'), ('u_friend', 'MAINLAND_ADD_FRIEND')");
            st.execute("""
                    INSERT INTO terminals (owner, fingerprint, type) VALUES
                      ('u_gray', 'mac-gray', 'DESKTOP'), ('u_gray', 'phone-gray', 'MOBILE'), ('u_other', 'mac-other', 'DESKTOP')""");
            st.execute("""
                    INSERT INTO app_release_grays (channel, version, target_type, target_id) VALUES
                      ('release', '1.0.0', 'USER', 'u_named'), ('pre', '1.0.0-pre', 'MACHINE', 'mac-named')""");
        }
        Configuration configuration = new Configuration(new Environment("test", new JdbcTransactionFactory(), dataSource));
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(AppReleaseMapper.class);
        session = new SqlSessionFactoryBuilder().build(configuration).openSession(true);
        mapper = session.getMapper(AppReleaseMapper.class);
    }

    @AfterEach
    void tearDown() throws Exception {
        session.close();
        keepAlive.close();
    }

    private List<String> visible(String userId, String machineId) {
        return mapper.findVisible("mac", List.of("pre", "release"), "arm64", userId, machineId).stream()
                .map(AppReleaseEntity::getVersion).sorted().toList();
    }

    @Test
    void taggedAccountSeesPre() {
        assertEquals(List.of("0.9.0", "1.0.0-pre"), visible("u_gray", "unknown"));
    }

    @Test
    void desktopOfTaggedAccountSeesPreWithoutLogin() {
        assertEquals(List.of("0.9.0", "1.0.0-pre"), visible(null, "mac-gray"));
    }

    @Test
    void othersDoNotSeePre() {
        assertEquals(List.of("0.9.0"), visible("u_friend", "mac-other"));
        assertEquals(List.of("0.9.0"), visible(null, null));
        // Phone fingerprints don't count: OTA only looks at computers
        assertEquals(List.of("0.9.0"), visible(null, "phone-gray"));
    }

    @Test
    void tagDoesNotOpenReleaseGray() {
        assertEquals(List.of("0.9.0", "1.0.0-pre"), visible("u_gray", null));
    }

    @Test
    void namedGrayRowsStillWork() {
        assertEquals(List.of("0.9.0", "1.0.0"), visible("u_named", null));
        assertEquals(List.of("0.9.0", "1.0.0-pre"), visible(null, "mac-named"));
    }
}
