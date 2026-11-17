package com.politeness.ading.conductor.dal.mapper;

import com.politeness.ading.conductor.dal.entity.AppReleaseEntity;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface AppReleaseMapper {

    /**
     * All versions this client can see: full-rollout ones, plus gray lists that name its account or computer;
     * pre-release also adds accounts tagged "pre-release gray" and the computers those accounts registered (standalone mode included).
     * The tag covers long-term recipients so they need not be registered for every release; app_release_grays is only for objects named for that release.
     * Version ordering is done by the service using semver; SQL cannot sort pre-release segments.
     * When userId / machineId is null the corresponding condition simply fails (= NULL is always false).
     *
     * Platform (mac / ios) must match: both share version numbers, but each has its own installer.
     *
     * Visible channels are given by the service (see AppUpdateService.visibleChannels): release and pre-release see each other,
     * dev only sees itself. The gray subquery still matches each row's own channel, so it never leaks onto another channel's list.
     *
     * **Pre-release is gray-only**: a `pre` row is visible only if it hits the gray list, even if written as `rollout = 'ALL'`.
     * Pre-release packages are signed but not notarized; pushing them to all release users would be an incident. Enforcing this at query level, not just at registration,
     * means manually changing a pre row to ALL still cannot push it out.
     */
    @Select("""
            <script>
            SELECT r.* FROM app_releases r
            WHERE r.platform = #{platform}
              AND r.channel IN
              <foreach item="c" collection="channels" open="(" separator="," close=")">#{c}</foreach>
              AND r.arch = #{arch}
              AND r.rollout IN ('ALL', 'GRAY')
              AND (
                   (r.rollout = 'ALL' AND r.channel &lt;&gt; 'pre')
                   OR EXISTS (
                         SELECT 1 FROM app_release_grays g
                         WHERE g.channel = r.channel
                           AND g.version = r.version
                           AND ((g.target_type = 'USER'    AND g.target_id = #{userId})
                             OR (g.target_type = 'MACHINE' AND g.target_id = #{machineId})))
                   OR (r.channel = 'pre' AND EXISTS (
                         SELECT 1 FROM user_tags ut
                         WHERE ut.tag = 'PRE_GRAY'
                           AND (ut.user_id = #{userId}
                             OR ut.user_id IN (SELECT t.owner FROM terminals t
                                               WHERE t.type = 'DESKTOP' AND t.fingerprint = #{machineId})))))
            </script>
            """)
    List<AppReleaseEntity> findVisible(@Param("platform") String platform,
                                       @Param("channels") List<String> channels,
                                       @Param("arch") String arch,
                                       @Param("userId") String userId,
                                       @Param("machineId") String machineId);
}
