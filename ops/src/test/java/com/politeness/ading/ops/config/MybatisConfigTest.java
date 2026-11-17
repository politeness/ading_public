package com.politeness.ading.ops.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.politeness.ading.ops.dal.mapper.ActivityMapper;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.annotation.MapperScan;
import org.mybatis.spring.boot.autoconfigure.MybatisAutoConfiguration;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/** The exclusion list comes from the deployment environment and must be written into MyBatis before the Mappers are parsed, otherwise nobody replaces the placeholder in the statistics SQL. */
class MybatisConfigTest {
    @MapperScan("com.politeness.ading.ops.dal.mapper")
    static class Mappers {}

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DataSourceAutoConfiguration.class, MybatisAutoConfiguration.class))
            .withUserConfiguration(MybatisConfig.class, Mappers.class)
            .withPropertyValues("spring.datasource.url=jdbc:h2:mem:mybatis-config;MODE=MySQL");

    @Test
    void excludedUsersReachTheParsedStatements() {
        runner.withPropertyValues("ading.ops.excluded-users= Review_A , review_b ").run(context -> {
            Configuration configuration = context.getBean(SqlSessionFactory.class).getConfiguration();
            assertEquals("review_a,review_b", configuration.getVariables().getProperty("statisticsExcludedUsernames"));
            context.getBean(ActivityMapper.class);
            String sql = configuration.getMappedStatement(ActivityMapper.class.getName() + ".countActiveUsers")
                    .getBoundSql(java.util.Map.of()).getSql();
            assertEquals(true, sql.contains(",review_a,review_b,"), sql);
            assertEquals(false, sql.contains("${"), sql);
        });
    }

    @Test
    void anythingThatIsNotAUsernameListIsRejected() {
        assertThrows(IllegalStateException.class,
                () -> com.politeness.ading.ops.dal.mapper.StatisticsExclusions.apply(new Configuration(), "a') OR ('1'='1"));
    }
}
