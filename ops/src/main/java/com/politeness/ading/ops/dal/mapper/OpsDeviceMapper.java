package com.politeness.ading.ops.dal.mapper;

import com.politeness.ading.ops.dal.OpsDeviceAccountRow;
import com.politeness.ading.ops.dal.OpsDeviceRow;
import java.time.LocalDateTime;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/**
 * Device data, read-only. Three layers: devices stores device parameters (one row per device), users are accounts, terminals is the many-to-many link between them,
 * terminal_sessions records connections. Online: has an open session and a connection was observed recently (conductor writes last_seen_at about every 30 s).
 */
@Mapper
public interface OpsDeviceMapper {

    String ONLINE_TERMINAL = """
            SELECT 1 FROM terminal_sessions s
             WHERE s.open_terminal_id = t.terminal_id AND s.last_seen_at >= #{onlineSince}
            """;

    /**
     * owner and activeSince both ask "was this account active on this device": connections and registration are recorded in terminals.last_seen_at,
     * history from before launch exists only in the hourly table, whose user_id is the account reported at the time.
     */
    String FILTER = """
            <where>
              """ + StatisticsScope.DEVICE_D + """

              <if test="keyword != null">
                 AND (d.device_uuid LIKE #{keyword} ESCAPE '\\\\'
               OR d.name LIKE #{keyword} ESCAPE '\\\\'
               OR d.city LIKE #{keyword} ESCAPE '\\\\'
               OR d.app_version LIKE #{keyword} ESCAPE '\\\\'
               OR EXISTS (SELECT 1 FROM terminals kt LEFT JOIN users ku ON ku.user_id = kt.owner
                           WHERE kt.fingerprint = d.device_uuid
                             AND (kt.terminal_id LIKE #{keyword} ESCAPE '\\\\'
                               OR ku.username LIKE #{keyword} ESCAPE '\\\\'
                               OR ku.display_name LIKE #{keyword} ESCAPE '\\\\'
                               OR ku.phone LIKE #{keyword} ESCAPE '\\\\'
                               OR ku.email LIKE #{keyword} ESCAPE '\\\\')))
              </if>
              <if test="registeredOnly"> AND EXISTS (SELECT 1 FROM terminals rt WHERE rt.fingerprint = d.device_uuid) </if>
              <if test="owner != null or activeSince != null">
                AND EXISTS (SELECT 1 FROM terminals ot WHERE ot.fingerprint = d.device_uuid
                  <if test="owner != null"> AND ot.owner = #{owner} </if>
                  <if test="activeSince != null">
                    AND (EXISTS (SELECT 1 FROM """ + StatisticsScope.ACTIVITY + """
                                  h
                                  WHERE h.device_uuid = ot.fingerprint AND h.user_id = ot.owner AND h.ended_at >= #{activeSince}))
                  </if>)
              </if>
              <if test="onlineFilterSince != null">
                AND EXISTS (SELECT 1 FROM terminals t JOIN terminal_sessions s ON s.open_terminal_id = t.terminal_id
                             WHERE t.fingerprint = d.device_uuid AND t.status != 'DISABLED' AND s.last_seen_at >= #{onlineFilterSince})
              </if>
            </where>
            """;

    @Select("SELECT COUNT(*) FROM devices d WHERE " + StatisticsScope.DEVICE_D)
    long countAllDevices();

    /** Number of devices with a registered account; a device counts once no matter how many accounts log in on it */
    @Select("SELECT COUNT(DISTINCT t.fingerprint) FROM terminals t WHERE " + StatisticsScope.TERMINAL_T)
    long countAllTerminals();

    @Select("""
            SELECT COUNT(DISTINCT t.fingerprint) FROM terminals t
              JOIN terminal_sessions s ON s.open_terminal_id = t.terminal_id
             WHERE """ + StatisticsScope.TERMINAL_T + """
                 AND t.status != 'DISABLED' AND s.last_seen_at >= #{onlineSince}
            """)
    long countOnlineTerminals(@Param("onlineSince") LocalDateTime onlineSince);

    String DEVICE_SELECT = """
            SELECT d.device_uuid,
                   d.device_type,
                   d.name, d.os_version, d.app_version, d.city,
                   COALESCE((SELECT GROUP_CONCAT(DISTINCT au.agent_type ORDER BY au.agent_type SEPARATOR ',')
                      FROM users au JOIN terminals at ON at.terminal_id=au.terminal_id
                     WHERE at.fingerprint=d.device_uuid AND au.is_agent=1 AND au.readiness='ready'
                       AND au.status='ACTIVE' AND (au.owner IS NULL OR au.owner NOT IN (""" + StatisticsScope.USERS + """
                       ))),
                     (SELECT dt.agents FROM device_telemetry dt WHERE dt.device_uuid = d.device_uuid)) AS agents,
                   d.first_seen_at, (SELECT MAX(s.ended_at) FROM """ + StatisticsScope.ACTIVITY + """
                   s WHERE s.device_uuid = d.device_uuid AND """ + StatisticsScope.SESSION_S + """
                   ) AS last_active_at,
                   CASE WHEN NOT EXISTS (SELECT 1 FROM terminals t WHERE t.fingerprint = d.device_uuid) THEN NULL
                        WHEN NOT EXISTS (SELECT 1 FROM terminals t WHERE t.fingerprint = d.device_uuid AND t.status != 'DISABLED') THEN 'DISABLED'
                        WHEN """ + OnlinePresence.DEVICE + """
                        THEN 'ONLINE'
                        ELSE 'OFFLINE' END AS status
              FROM devices d
            """;

    @Select("<script>SELECT * FROM (" + DEVICE_SELECT + FILTER + """
             ) device_activity
             ORDER BY CASE WHEN status = 'ONLINE' THEN 0 ELSE 1 END, last_active_at DESC, first_seen_at DESC, device_uuid
             LIMIT #{size} OFFSET #{offset}
            </script>
            """)
    List<OpsDeviceRow> searchDevices(@Param("keyword") String keyword,
                                     @Param("registeredOnly") boolean registeredOnly,
                                     @Param("onlineFilterSince") LocalDateTime onlineFilterSince,
                                     @Param("owner") String owner,
                                     @Param("activeSince") LocalDateTime activeSince,
                                     @Param("onlineSince") LocalDateTime onlineSince,
                                     @Param("offset") int offset,
                                     @Param("size") int size);

    @Select("""
            <script>
            SELECT COUNT(*) FROM devices d
            """ + FILTER + """
            </script>
            """)
    long countDevices(@Param("keyword") String keyword,
                      @Param("registeredOnly") boolean registeredOnly,
                                     @Param("onlineFilterSince") LocalDateTime onlineFilterSince,
                      @Param("owner") String owner,
                      @Param("activeSince") LocalDateTime activeSince);

    /** Only fills in device details for the current activity page; doesn't change the active scope or paging order. */
    @Select("<script>" + DEVICE_SELECT + """
             WHERE """ + StatisticsScope.DEVICE_D + """
                 AND d.device_uuid IN
               <foreach collection="deviceUuids" item="uuid" open="(" separator="," close=")">#{uuid}</foreach>
            </script>
            """)
    List<OpsDeviceRow> devicesByIds(@Param("deviceUuids") List<String> deviceUuids,
                                  @Param("onlineSince") LocalDateTime onlineSince);

    /** All accounts linked to these devices. Listed in full even when filtering by account: the filter only decides which devices are shown */
    @Select("""
            <script>
            SELECT t.fingerprint AS device_uuid, t.terminal_id, t.owner AS user_id, u.username, u.display_name, t.last_seen_at,
                   EXISTS (""" + ONLINE_TERMINAL + """
                   ) AS online
              FROM terminals t
              LEFT JOIN users u ON u.user_id = t.owner
             WHERE """ + StatisticsScope.TERMINAL_T + """
                 AND (t.owner IS NULL OR t.owner NOT IN (""" + StatisticsScope.USERS + """
                )) AND t.fingerprint IN
               <foreach collection="deviceUuids" item="uuid" open="(" separator="," close=")">#{uuid}</foreach>
             ORDER BY t.last_seen_at DESC, t.id DESC
            </script>
            """)
    List<OpsDeviceAccountRow> accountsOf(@Param("deviceUuids") List<String> deviceUuids,
                                         @Param("onlineSince") LocalDateTime onlineSince);
}
